#!/usr/bin/env node
// Writes one dataset to disk in the exact shapes the pipeline consumes:
//   ledger.csv          <- merchant's own book (CSV, like a Tally export)
//   bank_statement.csv  <- bank credits (CSV, like a net-banking download)
//   payments.json       <- Razorpay Payments API shape
//   settlements.json    <- Razorpay Settlements API shape
//   recon_report.json   <- razorpay.settlements.reports() shape, carries the UTR
//   truth.json          <- ground truth, never read by the matching engine
//
//   node server/src/cli/generate.js --seed 7 --out data/demo
//   node server/src/cli/generate.js --seed 424242 --out data/holdout

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateDataset } from '../generate/synth.js';
import { toCSV } from '../lib/csv.js';
import { paiseToDecimal, formatPaise } from '../lib/money.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed ?? 7);
const outDir = resolve(process.cwd(), args.out ?? 'data/demo');
const invoiceCount = Number(args.invoices ?? 72);

const ds = generateDataset({ seed, invoiceCount });
mkdirSync(outDir, { recursive: true });

// Internal bookkeeping fields (prefixed _) exist only to build ground truth.
// They must never reach the engine, or the accuracy numbers are worthless.
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));

const ledgerCsv = toCSV(
  ds.ledger.map((r) => ({ ...r, amount: paiseToDecimal(r.amount) })),
  ['invoice_id', 'order_ref', 'customer', 'invoice_date', 'amount', 'currency', 'status'],
);
const bankCsv = toCSV(
  ds.bank.map((r) => ({
    ...strip(r),
    credit: paiseToDecimal(r.credit),
    debit: paiseToDecimal(r.debit),
    balance: paiseToDecimal(r.balance),
  })),
  ['txn_id', 'value_date', 'description', 'utr', 'credit', 'debit', 'balance'],
);

const write = (name, content) => writeFileSync(resolve(outDir, name), content);
write('ledger.csv', ledgerCsv);
write('bank_statement.csv', bankCsv);
write('payments.json', JSON.stringify(ds.payments.map(strip), null, 2));
write('settlements.json', JSON.stringify(ds.settlements, null, 2));
write('recon_report.json', JSON.stringify(ds.reconRows, null, 2));
write('truth.json', JSON.stringify(ds.truth, null, 2));
write('manifest.json', JSON.stringify({ ...ds.manifest, source: 'synthetic' }, null, 2));

const grossPaise = ds.ledger.reduce((s, r) => s + r.amount, 0);
console.log(`dataset seed=${seed} -> ${outDir}`);
console.table(ds.manifest.counts);
console.log(`ledger gross          Rs ${formatPaise(grossPaise)}`);
console.log(`ground truth (ledger) ${ds.truth.summary.ledger_matched} matched / ${ds.truth.summary.ledger_exceptions} exceptions`);
console.log(`ground truth (bank)   ${ds.truth.summary.bank_matched} matched / ${ds.truth.summary.bank_exceptions} exceptions`);
