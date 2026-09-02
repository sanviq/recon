#!/usr/bin/env node
//   node server/src/cli/sweep.js --seeds 40 --profile standard
//
// Runs the whole pipeline over N independently seeded datasets and aggregates.
// A single good run is an anecdote; this is the distribution behind the headline
// number, including its worst case. Nothing here is cherry-picked — the worst
// seed is reported alongside the mean, by construction.
//
// Datasets are round-tripped through the same CSV serialisation and parsers the
// on-disk pipeline uses, so this scores the code that actually ships.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateDataset, PROFILES } from '../generate/synth.js';
import { materialize } from '../generate/serialize.js';
import { reconcile } from '../match/engine.js';
import { evaluate } from '../eval/score.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const seedCount = Number(args.seeds ?? 40);
const profile = String(args.profile ?? 'standard');
const outPath = args.out ? resolve(process.cwd(), String(args.out)) : null;

if (!PROFILES[profile]) {
  console.error(`unknown profile "${profile}" — expected one of: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}

// Threshold overrides, so the sensitivity of a threshold can be measured rather
// than argued about:
//   node server/src/cli/sweep.js --profile hard --ledger-window-max 7
const configOverride = {};
if (args['ledger-window-max'] !== undefined) {
  configOverride.ledgerDateWindow = { max: Number(args['ledger-window-max']) };
}
if (args['amount-tolerance-bps'] !== undefined) {
  configOverride.amountTolerance = { bps: Number(args['amount-tolerance-bps']) };
}

const runs = [];
const allMisroutes = [];
const allDisagreements = [];
let totalRecords = 0;
let totalMs = 0;

for (let i = 0; i < seedCount; i++) {
  // Deliberately not seeds 7 or 424242 — the two the thresholds were developed
  // against. These are all unseen.
  const seed = 100_000 + i * 7919;
  const generated = generateDataset({ seed, profile });
  const dataset = materialize(generated, `sweep/${profile}/${seed}`);

  const t0 = performance.now();
  const result = reconcile(dataset, configOverride);
  const ms = performance.now() - t0;

  const report = evaluate(dataset, result, ms);
  totalRecords += report.throughput.records;
  totalMs += ms;

  runs.push({ seed, ...report.accuracy, match_rate: report.accuracy.match_rate,
              value_share: report.value.auto_reconciled_share });
  for (const m of report.misroutes) allMisroutes.push({ seed, ...m });
  for (const d of report.disagreements) allDisagreements.push({ seed, ...d });
}

const stat = (key) => {
  const xs = runs.map((r) => r[key]).sort((a, b) => a - b);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return {
    min: Number(xs[0].toFixed(4)),
    p50: Number(xs[Math.floor(xs.length / 2)].toFixed(4)),
    mean: Number(mean.toFixed(4)),
    max: Number(xs[xs.length - 1].toFixed(4)),
  };
};

const summary = {
  profile,
  seeds: seedCount,
  generated_at: new Date().toISOString(),
  throughput: {
    total_records: totalRecords,
    total_ms: Number(totalMs.toFixed(1)),
    records_per_second: Math.round(totalRecords / (totalMs / 1000)),
  },
  match_rate: stat('match_rate'),
  precision_auto_matched: stat('precision_auto_matched'),
  recall: stat('recall'),
  reason_code_accuracy: stat('reason_code_accuracy'),
  bank_row_accuracy: stat('bank_row_accuracy'),
  // The headline safety claim. If this is not zero, the engine has booked money
  // to the wrong invoice somewhere and the claim does not hold.
  total_false_positives: runs.reduce((s, r) => s + r.false_positive, 0),
  total_misrouted_matches: allMisroutes.length,
  total_missed_matches: runs.reduce((s, r) => s + r.false_negative, 0),
  worst_seed_by_precision: runs.slice().sort((a, b) => a.precision_auto_matched - b.precision_auto_matched)[0],
  worst_seed_by_recall: runs.slice().sort((a, b) => a.recall - b.recall)[0],
  misroutes: allMisroutes.slice(0, 25),
  disagreement_kinds: allDisagreements.reduce((acc, d) => {
    const k = `${d.truth} != ${d.engine}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {}),
  runs,
};

if (outPath) writeFileSync(outPath, JSON.stringify(summary, null, 2));

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const line = (label, s) =>
  console.log(`  ${label.padEnd(24)} mean ${pct(s.mean).padStart(6)}   min ${pct(s.min).padStart(6)}   max ${pct(s.max).padStart(6)}`);

console.log(`\nRecon — ${seedCount} unseen seeds, profile "${profile}"`);
console.log(`  ${totalRecords} records total in ${totalMs.toFixed(0)}ms (${summary.throughput.records_per_second}/s)\n`);
line('match rate', summary.match_rate);
line('precision (auto-matched)', summary.precision_auto_matched);
line('recall', summary.recall);
line('reason-code accuracy', summary.reason_code_accuracy);
line('bank row accuracy', summary.bank_row_accuracy);
console.log(`\n  false positives across all seeds   ${summary.total_false_positives}`);
console.log(`  misrouted matches (wrong invoice)  ${summary.total_misrouted_matches}`);
console.log(`  missed matches (recall loss)       ${summary.total_missed_matches}`);

const kinds = Object.entries(summary.disagreement_kinds).sort((a, b) => b[1] - a[1]);
if (kinds.length) {
  console.log('\n  where it disagrees with ground truth');
  for (const [k, v] of kinds) console.log(`    ${String(v).padStart(4)}  ${k}`);
}
if (outPath) console.log(`\n  wrote ${outPath}`);
console.log();
