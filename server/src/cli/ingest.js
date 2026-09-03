#!/usr/bin/env node
//   node server/src/cli/ingest.js --bank statement.csv [--ledger book.csv] --out data/live
//
// Normalises somebody else's CSV into the shape the engine reads, and writes down
// exactly how it decided. Run this when the files did not come out of our own
// generator — a real HDFC download, a Tally export, a spreadsheet a finance team
// maintains by hand.
//
// The output is two canonical CSVs plus ingest.json. Everything after this point
// is the ordinary deterministic pipeline, reading ordinary canonical columns.

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCSV, toCSV } from '../lib/csv.js';
import { mapTable, describeMapping, hasApiKey, MODEL } from '../ingest/mapper.js';
import { applyMapping } from '../ingest/values.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(process.cwd(), args.out ?? 'data/ingested');
const useModel = !args['no-model'];

const jobs = [
  args.bank && { kind: 'bank', file: resolve(process.cwd(), String(args.bank)), out: 'bank_statement.csv',
                 columns: ['txn_id', 'value_date', 'description', 'utr', 'credit', 'debit'] },
  args.ledger && { kind: 'ledger', file: resolve(process.cwd(), String(args.ledger)), out: 'ledger.csv',
                   columns: ['invoice_id', 'order_ref', 'customer', 'invoice_date', 'amount', 'currency'] },
].filter(Boolean);

if (!jobs.length) {
  console.error('nothing to ingest — pass --bank <file.csv> and/or --ledger <file.csv>');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
console.log(`\ningest -> ${outDir}`);
console.log(`  ${useModel && hasApiKey() ? `${MODEL} column mapping + deterministic alias fallback` : 'deterministic alias table (no model)'}\n`);

const record = { generated_at: new Date().toISOString(), model: useModel && hasApiKey() ? MODEL : null, tables: {} };
let blocked = false;

for (const job of jobs) {
  const rows = parseCSV(readFileSync(job.file, 'utf8'));
  if (!rows.length) {
    console.error(`  ${job.kind}: ${job.file} has no data rows`);
    blocked = true;
    continue;
  }
  const headers = Object.keys(rows[0]);
  const res = await mapTable({ headers, rows, kind: job.kind, useModel });

  console.log(`  ${job.kind}  (${rows.length} rows, ${headers.length} columns, mapped by ${res.source})`);
  for (const r of describeMapping(res)) {
    const bar = r.confidence >= 0.9 ? '' : r.confidence >= 0.6 ? '  ~' : '  ?';
    console.log(`    ${r.field.padEnd(14)} <- ${`"${r.column}"`.padEnd(28)} ${r.confidence.toFixed(2)}${bar}  ${r.reason}`);
  }
  if (res.unmapped_columns.length) console.log(`    unused columns: ${res.unmapped_columns.join(', ')}`);
  console.log(`    dates read as ${res.date_format.format}${res.date_format.ambiguous ? ' (INFERRED, not proven — check a few rows)' : ''} — ${res.date_format.evidence}`);
  for (const w of res.warnings) console.log(`    ! ${w}`);

  if (res.missing_required.length) {
    console.error(`    FAILED: could not resolve required field(s): ${res.missing_required.join(', ')}`);
    blocked = true;
  }

  const canonical = applyMapping(rows, res.mapping, job.kind, { dateFormat: res.date_format.format });
  const undated = canonical.filter((r) => !(job.kind === 'bank' ? r.value_date : r.invoice_date)).length;
  if (undated) {
    console.error(`    FAILED: ${undated} row(s) have a date that could not be parsed as ${res.date_format.format}`);
    blocked = true;
  }

  if (!blocked) writeFileSync(resolve(outDir, job.out), toCSV(canonical, job.columns));
  record.tables[job.kind] = {
    source_file: job.file, rows: rows.length, headers,
    mapped_by: res.source, mapping: res.mapping, date_format: res.date_format,
    unmapped_columns: res.unmapped_columns, warnings: res.warnings,
  };
  console.log();
}

if (blocked) {
  console.error('ingest aborted — nothing written. Fix the file or pass the columns explicitly.\n');
  process.exit(1);
}

writeFileSync(resolve(outDir, 'ingest.json'), JSON.stringify(record, null, 2));

// How a column was interpreted is a decision about money, so it belongs in the
// same append-only trail as the matches it will later produce.
appendFileSync(
  resolve(outDir, 'audit.jsonl'),
  Object.entries(record.tables).flatMap(([kind, t]) =>
    Object.entries(t.mapping).map(([field, m]) => JSON.stringify({
      run_id: `ingest_${Date.now()}`, at: record.generated_at, leg: 'ingest',
      subject: kind, subject_id: field, decision: 'mapped', rule: t.mapped_by,
      confidence: m.confidence, counterpart: m.source_column,
      detail: { reason: m.reason, date_format: t.date_format.format },
    }))).join('\n') + '\n',
);

console.log(`  wrote ${jobs.map((j) => j.out).join(', ')} and ingest.json`);
if (!existsSync(resolve(outDir, 'recon_report.json'))) {
  console.log(`  note: no recon_report.json here yet — run \`npm run pull -- --out ${args.out ?? 'data/ingested'}\` for the Razorpay side before reconciling.`);
}
console.log();
