#!/usr/bin/env node
//   node server/src/cli/reconcile.js --data data/demo [--out data/demo]
//
// Runs the engine over one dataset and writes:
//   result.json  full per-record decisions and summary
//   audit.jsonl  append-only decision log, one JSON object per line

import { writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDataset } from '../sources/load.js';
import { reconcile } from '../match/engine.js';
import { formatPaise } from '../lib/money.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(process.cwd(), args.data ?? 'data/demo');
const outDir = resolve(process.cwd(), args.out ?? dataDir);

const t0 = performance.now();
const dataset = loadDataset(dataDir);
const result = reconcile(dataset);
const elapsedMs = performance.now() - t0;

const recordCount = dataset.ledger.length + dataset.payments.length + dataset.bank.length;
result.throughput = {
  records: recordCount,
  elapsed_ms: Number(elapsedMs.toFixed(1)),
  records_per_second: Math.round(recordCount / (elapsedMs / 1000)),
};

writeFileSync(resolve(outDir, 'result.json'), JSON.stringify(result, null, 2));

// The audit log is append-only by construction: every run appends its decisions
// and nothing ever rewrites an earlier line. That is the property that makes it
// evidence rather than a report.
const runId = `run_${Date.now()}`;
const auditPath = resolve(outDir, 'audit.jsonl');
appendFileSync(
  auditPath,
  result.audit.map((e) => JSON.stringify({ run_id: runId, dataset: dataDir, ...e })).join('\n') + '\n',
);

const s = result.summary;
console.log(`\nrecon ${dataDir}`);
console.log(`  ${recordCount} records in ${elapsedMs.toFixed(0)}ms (${result.throughput.records_per_second}/s)\n`);
console.log(`  invoices matched      ${s.matched}/${s.ledger_rows}  (${(s.match_rate * 100).toFixed(1)}%)`);
console.log(`  value auto-reconciled Rs ${formatPaise(s.value_matched_paise)}`);
console.log(`  value flagged         Rs ${formatPaise(s.value_flagged_paise)}`);
console.log(`  settlement batches    ${s.settlements_matched}/${s.settlement_groups} confirmed against bank`);
console.log(`  bank exceptions       ${s.bank_exceptions}/${s.bank_rows}  (Rs ${formatPaise(s.bank_unexplained_credit_paise)} unexplained)`);
console.log('\n  exceptions by reason');
for (const [reason, count] of Object.entries(s.exceptions_by_reason).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${reason.padEnd(24)} ${count}`);
}
console.log(`\n  wrote result.json and appended ${result.audit.length} audit entries to audit.jsonl\n`);
