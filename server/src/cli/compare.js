#!/usr/bin/env node
//   node server/src/cli/compare.js --seeds 40 --profile hard [--out metrics/compare_hard.json]
//   node server/src/cli/compare.js --data data/holdout
//
// Scores Recon against the two alternatives a merchant would plausibly have,
// on identical data, against identical ground truth, in the same process.
//
// The point is not that Recon wins. It is that the naive build wins on the
// headline number and loses on the one that costs money, and that contrast is
// only visible if all three are measured together.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateDataset, PROFILES } from '../generate/synth.js';
import { materialize } from '../generate/serialize.js';
import { loadDataset } from '../sources/load.js';
import { reconcile } from '../match/engine.js';
import { evaluate } from '../eval/score.js';
import { BASELINES } from '../eval/baselines.js';
import { formatPaise } from '../lib/money.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
// Scoring one dataset writes the comparison next to it by default, so the
// dashboard can show it without anyone having to remember a second flag.
const outPath = args.out ? resolve(process.cwd(), String(args.out))
  : args.data ? resolve(process.cwd(), String(args.data), 'compare.json')
  : null;

const SYSTEMS = {
  recon: { label: 'Recon (two legs, ambiguity refused)', run: (ds) => reconcile(ds) },
  ...BASELINES,
};

/** Every dataset this run scores. Either one on disk, or N generated seeds. */
function datasets() {
  if (args.data) {
    const ds = loadDataset(resolve(process.cwd(), String(args.data)));
    if (!ds.truth) {
      console.error(`${args.data} has no truth.json — accuracy is only measurable on a generated set`);
      process.exit(1);
    }
    return [ds];
  }
  const profile = String(args.profile ?? 'standard');
  if (!PROFILES[profile]) {
    console.error(`unknown profile "${profile}" — expected one of: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(1);
  }
  const count = Number(args.seeds ?? 40);
  // The same unseen seeds the sweep uses, so the two studies are comparable.
  return Array.from({ length: count }, (_, i) =>
    materialize(generateDataset({ seed: 100_000 + i * 7919, profile }), `compare/${profile}`));
}

const all = datasets();
const totals = Object.fromEntries(Object.keys(SYSTEMS).map((k) => [k, {
  runs: [], misroutes: 0, falsePositives: 0, falseNegatives: 0,
  matchedPaise: 0, flaggedPaise: 0, wrongPaise: 0,
}]));

for (const ds of all) {
  for (const [key, system] of Object.entries(SYSTEMS)) {
    const t0 = performance.now();
    const result = system.run(ds);
    const report = evaluate(ds, result, performance.now() - t0);
    const t = totals[key];
    t.runs.push(report.accuracy);
    t.misroutes += report.accuracy.misrouted_matches;
    t.falsePositives += report.accuracy.false_positive;
    t.falseNegatives += report.accuracy.false_negative;
    t.matchedPaise += report.value.auto_reconciled_paise;
    t.flaggedPaise += report.value.flagged_paise;

    // The number that matters most, and the one a headline match rate hides:
    // rupees the system declared reconciled that ground truth says were not.
    const truthById = new Map(ds.truth.ledger.map((x) => [x.invoice_id, x]));
    for (const l of result.ledger) {
      if (l.status !== 'matched') continue;
      const truth = truthById.get(l.invoice_id);
      if (!truth) continue;
      if (truth.status !== 'matched' || truth.payment_id !== l.payment_id) t.wrongPaise += l.ledger_amount;
    }
  }
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stat = (key, k) => mean(totals[key].runs.map((r) => r[k]));

const summary = {
  generated_at: new Date().toISOString(),
  datasets: all.length,
  profile: args.data ? String(args.data) : String(args.profile ?? 'standard'),
  systems: Object.fromEntries(Object.entries(SYSTEMS).map(([key, s]) => [key, {
    label: s.label,
    match_rate: Number(stat(key, 'match_rate').toFixed(4)),
    precision_auto_matched: Number(stat(key, 'precision_auto_matched').toFixed(4)),
    recall: Number(stat(key, 'recall').toFixed(4)),
    bank_row_accuracy: Number(stat(key, 'bank_row_accuracy').toFixed(4)),
    total_false_positives: totals[key].falsePositives,
    total_misrouted_matches: totals[key].misroutes,
    value_wrongly_declared_reconciled_paise: totals[key].wrongPaise,
    value_auto_reconciled_paise: totals[key].matchedPaise,
  }])),
};

if (outPath) writeFileSync(outPath, JSON.stringify(summary, null, 2));

const pct = (n) => `${(n * 100).toFixed(1)}%`;
console.log(`\nRecon vs the alternatives — ${all.length} dataset(s), profile "${summary.profile}"\n`);
console.log(`  ${'system'.padEnd(20)} ${'match'.padStart(7)} ${'precision'.padStart(10)} ${'recall'.padStart(8)} ${'bank'.padStart(7)}   ${'misrouted'.padStart(9)}   wrongly reconciled`);
console.log(`  ${'-'.repeat(96)}`);
for (const [key, s] of Object.entries(summary.systems)) {
  console.log(
    `  ${key.padEnd(20)} ${pct(s.match_rate).padStart(7)} ${pct(s.precision_auto_matched).padStart(10)} ` +
    `${pct(s.recall).padStart(8)} ${pct(s.bank_row_accuracy).padStart(7)}   ${String(s.total_misrouted_matches).padStart(9)}   ` +
    `Rs ${formatPaise(s.value_wrongly_declared_reconciled_paise)}`);
}
console.log('\n  ' + Object.entries(summary.systems).map(([k, s]) => `${k}: ${s.label}`).join('\n  '));

const naive = summary.systems.single_leg;
const recon = summary.systems.recon;
if (naive.match_rate > recon.match_rate) {
  console.log(`\n  Note: single_leg reports a HIGHER match rate than Recon (${pct(naive.match_rate)} vs ${pct(recon.match_rate)})`);
  console.log(`  and declares Rs ${formatPaise(naive.value_wrongly_declared_reconciled_paise)} reconciled that ground truth says was not.`);
  console.log('  A headline match rate, on its own, rewards exactly the wrong behaviour.');
}
if (outPath) console.log(`\n  wrote ${outPath}`);
console.log();
