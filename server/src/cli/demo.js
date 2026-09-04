#!/usr/bin/env node
//   node server/src/cli/demo.js [--seed 7] [--data data/demo]
//
// The whole story in one command, in the order it should be told: build a month
// with known faults, reconcile it, explain what could not be matched, prove the
// run holds together, then show what the alternatives would have scored.
//
// Exists because a five-minute demo should not be five minutes of typing.

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const args = parseArgs(process.argv.slice(2));
const data = String(args.data ?? 'data/demo');
const seed = String(args.seed ?? 7);

const B = '[1m';
const D = '[2m';
const R = '[0m';

const steps = [
  { title: 'A month of a merchant\'s books, with faults planted on purpose',
    why: 'Duplicate credits, late payouts, invoices with no payment, and two invoices for the same amount on the same day. Ground truth is written alongside, and the engine never sees it.',
    cmd: ['generate.js', '--seed', seed, '--out', data] },

  { title: 'Reconcile — three sources, two legs, no model involved',
    why: 'Ledger to payment, then settlement UTR to bank credit. An invoice is confirmed only when both hold.',
    cmd: ['reconcile.js', '--data', data] },

  { title: 'Explain — a plain-English note on every flagged row, plus the brief',
    why: 'The only place a model touches this. The decisions are already made; it writes them down for a human.',
    cmd: ['explain.js', '--data', data] },

  { title: 'Verify — the run checked against its own claims',
    why: 'Determinism, audit completeness, sequence integrity, and that no rupee is counted twice.',
    cmd: ['verify.js', '--data', data] },

  { title: 'Score — measured against ground truth it never saw',
    why: 'Precision on the auto-matched set is the number that matters: a false match is money silently booked to the wrong invoice.',
    cmd: ['evaluate.js', '--data', data] },

  // Scored over 40 generated datasets rather than the one just reconciled. The
  // contrast is the whole argument, and a single dataset is a weak place to make
  // it — the same finding across forty unseen months is the difference between
  // an anecdote and a result. It costs about half a second.
  { title: 'Compare — what the alternatives score across 40 unseen months',
    why: 'The naive build reports a higher match rate and books real money to the wrong place. That contrast is the entire argument.',
    cmd: ['compare.js', '--seeds', '40', '--profile', 'hard', '--out', `${data}/compare.json`] },
];

console.log(`\n${B}Recon${R} — reconciliation for Razorpay merchants, end to end\n`);

for (const [i, step] of steps.entries()) {
  console.log(`${B}${'─'.repeat(78)}${R}`);
  console.log(`${B}${i + 1}. ${step.title}${R}`);
  console.log(`${D}   ${step.why}${R}`);
  console.log(`${D}   $ node server/src/cli/${step.cmd.join(' ')}${R}`);

  const out = spawnSync(process.execPath, [resolve(here, step.cmd[0]), ...step.cmd.slice(1)], {
    cwd: repoRoot, stdio: 'inherit',
  });
  // verify exits non-zero when a check fails, and that is worth stopping on.
  if (out.status !== 0) {
    console.error(`\n${B}step ${i + 1} failed — stopping${R}\n`);
    process.exit(out.status ?? 1);
  }
}

console.log(`${B}${'─'.repeat(78)}${R}`);
console.log(`\n${B}Now the dashboard:${R}  npm run serve   ${D}→ http://localhost:8787${R}`);
console.log(`${D}   The month-end brief, the exception list with a note on every row,${R}`);
console.log(`${D}   the audit trail, and a chat box you can ask about any of it.${R}\n`);
