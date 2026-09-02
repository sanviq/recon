#!/usr/bin/env node
//   node server/src/cli/pull.js --from 2026-08-01 --to 2026-08-31 --out data/live
//
// Pulls real payments and settlement recon rows from Razorpay test mode, then
// builds the merchant ledger and bank statement around them so the same
// three-source pipeline runs unchanged.
//
// Two things this is deliberately loud about:
//   - it refuses to run against a live key
//   - test mode does not run a real settlement cycle, so when the recon report
//     is empty the settlement schedule is derived locally and every artefact is
//     stamped derived: true rather than passing off a made-up UTR as Razorpay's

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  makeClient, fetchPayments, fetchSettlements, fetchReconReport,
  deriveSettlements, reconRowsFrom, linkSettlements,
} from '../sources/razorpay.js';
import { buildCounterparts } from '../generate/fromPayments.js';
import { ledgerCSV, bankCSV } from '../generate/serialize.js';
import { formatPaise } from '../lib/money.js';
import { toISODate, addDays } from '../lib/dates.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const to = String(args.to ?? toISODate(Date.now()));
const from = String(args.from ?? addDays(to, -30));
const outDir = resolve(process.cwd(), args.out ?? 'data/live');
const seed = Number(args.seed ?? 7);
const profile = String(args.profile ?? 'standard');

let client;
try {
  client = makeClient();
} catch (err) {
  // A missing key is a setup problem, not a crash. A stack trace here just
  // buries the one line that tells you what to do.
  console.error(`\n${err.message}\n`);
  console.error('Or skip live credentials entirely — the synthetic path needs none:');
  console.error('  npm run generate -- --seed 7 --out data/demo\n');
  process.exit(1);
}

console.log(`pulling Razorpay test mode ${from} .. ${to}`);

const payments = await fetchPayments(client, { from, to });
console.log(`  ${payments.length} captured payments`);

if (payments.length === 0) {
  console.error(`
No captured payments in that window.

Test mode only has payments you have actually put through it. To create some:
  Razorpay Dashboard (Test Mode) > Payment Links, or run a test checkout with
  card 4111 1111 1111 1111, any future expiry, any CVV.

Then re-run this command. To work without live credentials at all, use the
fully synthetic path, which needs no keys:
  npm run generate -- --seed 7 --out data/demo
`);
  process.exit(1);
}

// The recon report is the only endpoint that says which payment was settled
// under which UTR. Without it there is no join key for the bank leg at all.
let reconRows = await fetchReconReport(client, { from, to });
let settlements = await fetchSettlements(client, { from, to });
let derived = false;

if (reconRows.length === 0) {
  derived = true;
  console.log('  settlement recon report is empty (normal in test mode) — deriving the payout schedule locally');
  settlements = deriveSettlements(payments);
  reconRows = reconRowsFrom(payments, settlements);
} else {
  settlements = linkSettlements(settlements, reconRows);
  console.log(`  ${settlements.length} settlements, ${reconRows.length} recon rows from the API`);
}

const settled = new Set(reconRows.map((r) => r.payment_id ?? r.entity_id));
const unsettled = payments.filter((p) => !settled.has(p.id)).length;
if (unsettled) console.log(`  ${unsettled} captured payment(s) not yet settled — these will be flagged, not matched`);

const { ledger, bank, truth, faults, notes } = buildCounterparts(payments, settlements, { seed, profile });

mkdirSync(outDir, { recursive: true });
const write = (name, content) => writeFileSync(resolve(outDir, name), content);
write('ledger.csv', ledgerCSV(ledger));
write('bank_statement.csv', bankCSV(bank));
write('payments.json', JSON.stringify(payments, null, 2));
write('settlements.json', JSON.stringify(settlements, null, 2));
write('recon_report.json', JSON.stringify(reconRows, null, 2));
write('truth.json', JSON.stringify(truth, null, 2));
write('manifest.json', JSON.stringify({
  source: 'razorpay_test_mode',
  // The single most important field in this file: whether the UTRs came from
  // Razorpay or from us.
  derived_settlements: derived,
  key_id: process.env.RAZORPAY_KEY_ID,
  window: { from, to },
  seed, profile, faults, notes,
  pulled_at: new Date().toISOString(),
  counts: { ledger: ledger.length, payments: payments.length,
            settlements: settlements.length, recon_rows: reconRows.length, bank: bank.length },
}, null, 2));

console.log(`\nwrote ${outDir}`);
console.log(`  ledger ${ledger.length} | payments ${payments.length} | settlements ${settlements.length} | bank ${bank.length}`);
console.log(`  gross captured Rs ${formatPaise(payments.reduce((s, p) => s + p.amount, 0))}`);
if (derived) console.log(`  NOTE: settlement UTRs are derived locally, not issued by Razorpay (manifest.derived_settlements = true)`);
console.log(`\nnext: node server/src/cli/reconcile.js --data ${args.out ?? 'data/live'}\n`);
