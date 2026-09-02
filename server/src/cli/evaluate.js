#!/usr/bin/env node
//   node server/src/cli/evaluate.js --data data/holdout
//
// Scores the engine against a labelled dataset and writes metrics.json. The
// numbers in the README come from the held-out seed, which the thresholds were
// never tuned against.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDataset } from '../sources/load.js';
import { reconcile } from '../match/engine.js';
import { evaluate, printReport } from '../eval/score.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(process.cwd(), args.data ?? 'data/holdout');

const dataset = loadDataset(dataDir);
if (!dataset.truth) {
  console.error(`no truth.json in ${dataDir} — evaluation needs a labelled dataset`);
  process.exit(1);
}

const t0 = performance.now();
const result = reconcile(dataset);
const report = evaluate(dataset, result, performance.now() - t0);

writeFileSync(resolve(dataDir, 'metrics.json'), JSON.stringify(report, null, 2));
printReport(report);
console.log(`  wrote ${resolve(dataDir, 'metrics.json')}\n`);
