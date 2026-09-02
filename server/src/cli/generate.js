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
//   node server/src/cli/generate.js --seed 424242 --out data/holdout --profile hard

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateDataset, PROFILES } from '../generate/synth.js';
import { serializeDataset } from '../generate/serialize.js';
import { formatPaise } from '../lib/money.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed ?? 7);
const outDir = resolve(process.cwd(), args.out ?? 'data/demo');
const profile = String(args.profile ?? 'standard');

if (!PROFILES[profile]) {
  console.error(`unknown profile "${profile}" — expected one of: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}

const ds = generateDataset({
  seed,
  profile,
  invoiceCount: args.invoices ? Number(args.invoices) : undefined,
});

mkdirSync(outDir, { recursive: true });
for (const [name, content] of Object.entries(serializeDataset(ds))) {
  writeFileSync(resolve(outDir, name), content);
}

const grossPaise = ds.ledger.reduce((s, r) => s + r.amount, 0);
console.log(`dataset seed=${seed} profile=${profile} -> ${outDir}`);
console.table(ds.manifest.counts);
console.log(`ledger gross          Rs ${formatPaise(grossPaise)}`);
console.log(`ground truth (ledger) ${ds.truth.summary.ledger_matched} matched / ${ds.truth.summary.ledger_exceptions} exceptions`);
console.log(`ground truth (bank)   ${ds.truth.summary.bank_matched} matched / ${ds.truth.summary.bank_exceptions} exceptions`);
