#!/usr/bin/env node
//   node server/src/cli/verify.js --data data/holdout
//
// Checks the claims this project makes about itself, rather than asking anyone to
// take them on trust:
//
//   1. Determinism    — the same input produces a byte-identical result.
//   2. Completeness   — every decision in result.json has a line in the audit log.
//   3. Integrity      — audit sequence numbers are dense, so a removed line shows.
//   4. Conservation   — no rupee is counted twice or lost between the buckets.
//   5. Exclusivity    — every record is in exactly one bucket, with a reason if flagged.
//
// A reconciliation tool that cannot demonstrate its own arithmetic has no business
// asking a merchant to trust it with theirs.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadDataset } from '../sources/load.js';
import { reconcile } from '../match/engine.js';
import { formatPaise } from '../lib/money.js';
import { STATUS, ALL_REASONS } from '../match/codes.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(process.cwd(), args.data ?? 'data/demo');

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

const dataset = loadDataset(dataDir);

// --- 1. determinism ---------------------------------------------------------
// Strip the wall-clock fields, which are the only thing that legitimately differs
// between two runs of the same input.
const stable = (r) => JSON.stringify({
  ledger: r.ledger, bank: r.bank, groups: r.groups, summary: r.summary,
  audit: r.audit.map(({ at, ...rest }) => rest),
});
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const runA = reconcile(dataset);
const runB = reconcile(loadDataset(dataDir));
const hashA = hash(stable(runA));
check('determinism', hashA === hash(stable(runB)),
  `two independent runs hash to ${hashA}`);

// --- 2. completeness --------------------------------------------------------
const auditPath = resolve(dataDir, 'audit.jsonl');
const decided = new Set(runA.audit.map((e) => `${e.subject}:${e.subject_id}`));
const missing = [
  ...runA.ledger.filter((l) => !decided.has(`ledger:${l.invoice_id}`) && !decided.has(`invoice:${l.invoice_id}`)),
].map((l) => l.invoice_id);
check('every invoice reaches the audit trail', missing.length === 0,
  missing.length ? `${missing.length} undocumented: ${missing.slice(0, 5).join(', ')}` : `${runA.audit.length} entries for ${runA.ledger.length} invoices`);

// --- 3. audit integrity -----------------------------------------------------
if (existsSync(auditPath)) {
  const lines = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
  let parsed = 0;
  const runs = new Map();
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    parsed++;
    if (typeof e.seq !== 'number') continue;
    const s = runs.get(e.run_id) ?? [];
    s.push(e.seq);
    runs.set(e.run_id, s);
  }
  check('every audit line is valid JSON', parsed === lines.length,
    `${parsed}/${lines.length} lines parsed`);

  const gaps = [];
  for (const [runId, seqs] of runs) {
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i + 1) { gaps.push(`${runId} jumps to ${sorted[i]} at position ${i + 1}`); break; }
    }
  }
  check('audit sequences are dense (no line removed)', gaps.length === 0,
    gaps.length ? gaps.slice(0, 3).join('; ') : `${runs.size} run(s), all sequential`);
} else {
  check('audit log present', false, `no audit.jsonl in ${dataDir} — run reconcile first`);
}

// --- 4. value conservation --------------------------------------------------
const s = runA.summary;
const invoiced = dataset.ledger.reduce((t, l) => t + l.amount, 0);
check('every rupee is in exactly one bucket',
  s.value_matched_paise + s.value_flagged_paise === invoiced,
  `matched ${formatPaise(s.value_matched_paise)} + flagged ${formatPaise(s.value_flagged_paise)} = invoiced ${formatPaise(invoiced)}`);

check('matched + flagged equals the invoice count',
  s.matched + s.exceptions === s.ledger_rows,
  `${s.matched} + ${s.exceptions} = ${s.ledger_rows}`);

// --- 5. bucket exclusivity --------------------------------------------------
const badStatus = runA.ledger.filter((l) => l.status !== STATUS.MATCHED && l.status !== STATUS.EXCEPTION);
check('no record is in an undefined state', badStatus.length === 0,
  badStatus.length ? `${badStatus.length} rows` : `${runA.ledger.length} invoices, 2 possible states`);

const reasonless = runA.ledger.filter((l) => l.status === STATUS.EXCEPTION && !ALL_REASONS.includes(l.reason));
check('every flagged record carries a known reason code', reasonless.length === 0,
  reasonless.length ? `${reasonless.length} without one: ${reasonless.slice(0, 3).map((r) => r.invoice_id).join(', ')}` : `${s.exceptions} flagged, all coded`);

const doubleClaimed = new Map();
for (const l of runA.ledger) {
  if (l.status !== STATUS.MATCHED || !l.payment_id) continue;
  doubleClaimed.set(l.payment_id, (doubleClaimed.get(l.payment_id) ?? 0) + 1);
}
const dupes = [...doubleClaimed.entries()].filter(([, n]) => n > 1);
check('no payment is claimed by two invoices', dupes.length === 0,
  dupes.length ? dupes.slice(0, 3).map(([p, n]) => `${p} x${n}`).join(', ') : `${doubleClaimed.size} payments, each claimed once`);

// --- 6. ground truth, when there is any -------------------------------------
if (dataset.truth) {
  const truthById = new Map(dataset.truth.ledger.map((t) => [t.invoice_id, t]));
  const wrong = runA.ledger.filter((l) => {
    if (l.status !== STATUS.MATCHED) return false;
    const t = truthById.get(l.invoice_id);
    return t && (t.status !== STATUS.MATCHED || t.payment_id !== l.payment_id);
  });
  check('nothing auto-matched contradicts ground truth', wrong.length === 0,
    wrong.length ? `${wrong.length} wrongly matched: ${wrong.slice(0, 3).map((w) => w.invoice_id).join(', ')}`
                 : `${runA.ledger.filter((l) => l.status === STATUS.MATCHED).length} auto-matched, all correct`);
}

// --- report -----------------------------------------------------------------
console.log(`\nRecon — verifying ${dataDir}\n`);
for (const c of checks) {
  console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(46)} ${c.detail}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
