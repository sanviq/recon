#!/usr/bin/env node
//   node server/src/cli/explain.js --data data/demo [--concurrency 4]
//
// Reads result.json, writes a plain-English note for every exception, and
// appends each one to the audit trail. Runs with or without ANTHROPIC_API_KEY —
// without it, every note comes from the deterministic templates.

import 'dotenv/config';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { explainAll, hasApiKey, MODEL } from '../explain/explainer.js';
import { STATUS } from '../match/codes.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(process.cwd(), args.data ?? 'data/demo');
const resultPath = resolve(dataDir, 'result.json');
const result = JSON.parse(readFileSync(resultPath, 'utf8'));

const groupByUTR = new Map(result.groups.map((g) => [g.utr, g]));
const paymentById = new Map(result.payments.map((p) => [p.id, p]));

// Every flagged record gets a note: the invoices the merchant will chase, and
// the bank credits nobody can account for.
const targets = [
  ...result.ledger
    .filter((row) => row.status === STATUS.EXCEPTION)
    .map((row) => ({
      key: row.invoice_id,
      row,
      context: { group: row.utr ? groupByUTR.get(row.utr) : null, payment: paymentById.get(row.payment_id) },
    })),
  ...result.bank
    .filter((b) => b.status === STATUS.EXCEPTION && !groupByUTR.has(b.utr))
    .map((b) => ({ key: b.txn_id, row: b, context: { kind: 'bank' } })),
];

if (targets.length === 0) {
  console.log('no exceptions to explain');
  process.exit(0);
}

const live = hasApiKey();
console.log(`explaining ${targets.length} exception(s) — ${live ? `${MODEL} + deterministic fallback` : 'deterministic templates (no ANTHROPIC_API_KEY set)'}`);

const t0 = performance.now();
const notes = await explainAll(targets, {
  concurrency: Number(args.concurrency ?? 4),
  onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`),
});
process.stdout.write('\n');
const elapsedMs = performance.now() - t0;

const byKey = new Map(targets.map((t, i) => [t.key, notes[i]]));
const attach = (row, key) => (byKey.has(key) ? { ...row, note: byKey.get(key) } : row);
result.ledger = result.ledger.map((row) => attach(row, row.invoice_id));
result.bank = result.bank.map((row) => attach(row, row.txn_id));

const usage = notes.reduce((acc, n) => {
  if (!n.usage) return acc;
  acc.input += n.usage.input_tokens ?? 0;
  acc.output += n.usage.output_tokens ?? 0;
  acc.cache_read += n.usage.cache_read_input_tokens ?? 0;
  acc.cache_write += n.usage.cache_creation_input_tokens ?? 0;
  return acc;
}, { input: 0, output: 0, cache_read: 0, cache_write: 0 });

result.explanations = {
  generated_at: new Date().toISOString(),
  model: live ? MODEL : null,
  count: notes.length,
  from_model: notes.filter((n) => n.source === 'llm').length,
  from_template: notes.filter((n) => n.source === 'template').length,
  elapsed_ms: Number(elapsedMs.toFixed(1)),
  usage,
};

writeFileSync(resultPath, JSON.stringify(result, null, 2));

// The explanations are decisions too — who said what about which record, and
// whether a model or a template said it. That belongs in the trail.
appendFileSync(
  resolve(dataDir, 'audit.jsonl'),
  targets.map((t, i) => JSON.stringify({
    run_id: `explain_${Date.now()}`,
    at: new Date().toISOString(),
    leg: 'explain',
    subject: t.context.kind === 'bank' ? 'bank' : 'invoice',
    subject_id: t.key,
    decision: 'explained',
    reason: t.row.reason,
    source: notes[i].source,
    model: notes[i].model ?? null,
    severity: notes[i].severity,
    detail: { explanation: notes[i].explanation, suggested_action: notes[i].suggested_action,
              facts_hash: notes[i].facts_hash, fallback_reason: notes[i].fallback_reason ?? null },
  })).join('\n') + '\n',
);

console.log(`\n  ${result.explanations.from_model} by model, ${result.explanations.from_template} by template, ${elapsedMs.toFixed(0)}ms`);
if (usage.input) {
  console.log(`  tokens: ${usage.input} in / ${usage.output} out | cache ${usage.cache_read} read, ${usage.cache_write} written`);
}
const bySeverity = notes.reduce((a, n) => ({ ...a, [n.severity]: (a[n.severity] ?? 0) + 1 }), {});
console.log(`  severity: ${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(', ')}`);

const sample = notes.find((n) => n.severity === 'high') ?? notes[0];
console.log(`\n  sample (${sample.source}):\n    ${sample.explanation}\n    -> ${sample.suggested_action}\n`);
