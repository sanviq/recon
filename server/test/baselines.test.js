import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../src/generate/synth.js';
import { materialize } from '../src/generate/serialize.js';
import { reconcile } from '../src/match/engine.js';
import { evaluate } from '../src/eval/score.js';
import { spreadsheetBaseline, singleLegBaseline, BASELINES } from '../src/eval/baselines.js';
import { priceRun, comparedToHuman, formatCostLine, PRICING } from '../src/explain/cost.js';
import { STATUS } from '../src/match/codes.js';

const dataset = materialize(generateDataset({ seed: 991, profile: 'standard' }), 'memory/baseline-test');
const score = (result) => evaluate(dataset, result, 1);

const recon = score(reconcile(dataset));
const spreadsheet = score(spreadsheetBaseline(dataset));
const singleLeg = score(singleLegBaseline(dataset));

// Assertions are directional, not exact. The claim is about the shape of the
// trade-off, and it has to keep holding when the generator is tuned.

test('the spreadsheet approach matches essentially nothing, which is why the problem exists', () => {
  assert.ok(spreadsheet.accuracy.match_rate < 0.05,
    `VLOOKUP on invoice amount scored ${spreadsheet.accuracy.match_rate} — fees and batching mean the invoice amount is never a number in the bank`);
});

// The finding the whole comparison exists to surface.
test('the naive build reports a HIGHER match rate than Recon', () => {
  assert.ok(singleLeg.accuracy.match_rate > recon.accuracy.match_rate,
    `single_leg ${singleLeg.accuracy.match_rate} vs recon ${recon.accuracy.match_rate}`);
});

test('...and pays for it in precision, which is the number that costs money', () => {
  assert.ok(singleLeg.accuracy.precision_auto_matched < recon.accuracy.precision_auto_matched);
  assert.ok(singleLeg.accuracy.false_positive > 0, 'it declares invoices reconciled that were not');
  assert.equal(recon.accuracy.false_positive, 0);
});

test('the naive build never opens the bank statement, and its bank accuracy shows it', () => {
  assert.ok(singleLeg.accuracy.bank_row_accuracy < recon.accuracy.bank_row_accuracy);
  assert.equal(recon.accuracy.bank_row_accuracy, 1);
});

test('every baseline produces a result the scorer can read without special-casing', () => {
  for (const [name, b] of Object.entries(BASELINES)) {
    const r = b.run(dataset);
    assert.equal(r.ledger.length, dataset.ledger.length, `${name}: ledger length`);
    assert.ok(r.summary.matched + r.summary.exceptions === r.summary.ledger_rows, `${name}: buckets`);
    for (const row of r.ledger) {
      assert.ok([STATUS.MATCHED, STATUS.EXCEPTION].includes(row.status), `${name}: undefined status`);
      if (row.status === STATUS.EXCEPTION) assert.ok(row.reason, `${name}: flagged with no reason`);
    }
    assert.doesNotThrow(() => score(r), `${name}: not scoreable`);
  }
});

test('no baseline claims a payment twice — the comparison would be unfair otherwise', () => {
  for (const [name, b] of Object.entries(BASELINES)) {
    const claimed = b.run(dataset).ledger.filter((l) => l.status === STATUS.MATCHED && l.payment_id).map((l) => l.payment_id);
    assert.equal(new Set(claimed).size, claimed.length, `${name} double-claimed a payment`);
  }
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('a run priced from real token counts, at the published rates', () => {
  const cost = priceRun({ input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 });
  assert.equal(cost.usd, PRICING['claude-opus-5'].input);

  const out = priceRun({ input: 0, output: 1_000_000, cache_read: 0, cache_write: 0 });
  assert.equal(out.usd, PRICING['claude-opus-5'].output);
});

test('cache reads are billed cheaper, and the saving is reported', () => {
  const cached = priceRun({ input: 0, output: 0, cache_read: 1_000_000, cache_write: 0 });
  const uncached = priceRun({ input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 });
  assert.ok(cached.usd < uncached.usd);
  assert.equal(cached.cache_saved_usd, Number((uncached.usd - cached.usd).toFixed(6)));
});

test('an unknown model is priced as null rather than guessed at', () => {
  assert.equal(priceRun({ input: 100 }, 'some-other-model'), null);
  assert.equal(priceRun(null), null);
});

test('the human comparison divides by the actual exception count', () => {
  const cost = priceRun({ input: 100_000, output: 5_000, cache_read: 200_000, cache_write: 2_000 });
  const e = comparedToHuman(24, 8_000, cost);
  assert.equal(e.exceptions, 24);
  assert.equal(e.human_seconds, 24 * 90);
  assert.equal(e.machine_seconds, 8);
  assert.ok(e.speedup > 1);
  assert.equal(e.usd_per_exception, Number((cost.usd / 24).toFixed(6)));
});

test('a template-only run reports zero cost honestly instead of hiding the line', () => {
  const line = formatCostLine(comparedToHuman(24, 18, null), null);
  assert.match(line, /\$0\.00/);
  assert.match(line, /deterministic templates/);
});
