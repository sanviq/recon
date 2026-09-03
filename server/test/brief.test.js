import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../src/generate/synth.js';
import { materialize } from '../src/generate/serialize.js';
import { reconcile } from '../src/match/engine.js';
import { buildBriefFacts, templateBrief, writeBrief } from '../src/explain/brief.js';
import { STATUS, REASON } from '../src/match/codes.js';

const dataset = materialize(generateDataset({ seed: 991, profile: 'standard' }), 'memory/brief-test');
const result = reconcile(dataset);

test('the brief is written from rupees, never from paise integers', () => {
  const facts = buildBriefFacts(result);
  assert.match(facts.value_flagged_rupees, /^[\d,]+\.\d{2}$/);
  assert.match(facts.value_auto_reconciled_rupees, /^[\d,]+\.\d{2}$/);
  for (const inv of facts.largest_flagged_invoices) assert.match(inv.amount_rupees, /\.\d{2}$/);
});

test('the largest flagged invoices are actually the largest', () => {
  const facts = buildBriefFacts(result, { topN: 5 });
  const amounts = facts.largest_flagged_invoices.map((i) => Number(i.amount_rupees.replace(/,/g, '')));
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a));
});

// Five invoices flagged because one payout was short-credited is one problem,
// not five. Without the grouping the brief lists the same cause five times and
// buries whatever else went wrong that month.
test('invoices flagged by one broken payout are grouped into a single problem', () => {
  const fixture = {
    summary: {
      ledger_rows: 10, matched: 5, exceptions: 5, match_rate: 0.5,
      value_matched_paise: 500_000, value_flagged_paise: 500_000,
      exceptions_by_reason: { [REASON.AMOUNT_MISMATCH]: 5 },
      settlement_groups: 2, settlements_matched: 1,
      bank_rows: 2, bank_exceptions: 0, bank_unexplained_credit_paise: 0,
    },
    ledger: Array.from({ length: 5 }, (_, i) => ({
      invoice_id: `INV-${i}`, customer: 'Coastal Foods', date: '2026-08-17',
      ledger_amount: 100_000, status: STATUS.EXCEPTION, reason: REASON.AMOUNT_MISMATCH,
      utr: 'HDFCN2608219874', leg_a: { status: STATUS.MATCHED }, leg_b: { status: STATUS.EXCEPTION },
    })),
    bank: [],
  };

  const facts = buildBriefFacts(fixture);
  assert.equal(facts.broken_payouts.length, 1);
  assert.equal(facts.broken_payouts[0].utr, 'HDFCN2608219874');
  assert.equal(facts.broken_payouts[0].invoices_affected, 5);
  assert.equal(facts.broken_payouts[0].invoice_value_rupees, '5,000.00');

  const brief = templateBrief(facts);
  assert.equal(brief.needs_attention.filter((i) => i.detail.includes('HDFCN2608219874')).length, 1);
  assert.match(brief.biggest_single_risk, /HDFCN2608219874/);
});

// An invoice that matched its payment perfectly is not itself a broken payout —
// only a failed bank leg puts it in that bucket.
test('an invoice whose own leg failed is not attributed to its payout', () => {
  const facts = buildBriefFacts({
    summary: { ledger_rows: 1, matched: 0, exceptions: 1, match_rate: 0, value_matched_paise: 0,
               value_flagged_paise: 100_000, exceptions_by_reason: {}, settlement_groups: 1,
               settlements_matched: 1, bank_rows: 1, bank_exceptions: 0, bank_unexplained_credit_paise: 0 },
    ledger: [{ invoice_id: 'INV-1', ledger_amount: 100_000, date: '2026-08-01', status: STATUS.EXCEPTION,
               reason: REASON.AMOUNT_MISMATCH, utr: 'HDFCN1',
               leg_a: { status: STATUS.EXCEPTION }, leg_b: { status: STATUS.MATCHED } }],
    bank: [],
  });
  assert.equal(facts.broken_payouts.length, 0);
  assert.equal(facts.largest_flagged_invoices[0].failing_leg, 'ledger_to_payment');
});

test('a clean month reads as a clean month rather than manufacturing concern', () => {
  const brief = templateBrief(buildBriefFacts({
    summary: { ledger_rows: 40, matched: 40, exceptions: 0, match_rate: 1,
               value_matched_paise: 4_000_000, value_flagged_paise: 0, exceptions_by_reason: {},
               settlement_groups: 8, settlements_matched: 8, bank_rows: 8, bank_exceptions: 0,
               bank_unexplained_credit_paise: 0 },
    ledger: [], bank: [],
  }));
  assert.match(brief.headline, /All 40 invoices reconciled/);
  assert.equal(brief.needs_attention.length, 1);
  assert.equal(brief.needs_attention[0].severity, 'low');
  assert.match(brief.biggest_single_risk, /Nothing/i);
});

test('unexplained bank credit is raised even when every invoice matched', () => {
  const brief = templateBrief(buildBriefFacts({
    summary: { ledger_rows: 5, matched: 5, exceptions: 0, match_rate: 1,
               value_matched_paise: 500_000, value_flagged_paise: 0, exceptions_by_reason: {},
               settlement_groups: 1, settlements_matched: 1, bank_rows: 2, bank_exceptions: 1,
               bank_unexplained_credit_paise: 5_170_581 },
    ledger: [],
    bank: [{ txn_id: 'TXN9', date: '2026-08-20', credit: 5_170_581, utr: 'UNKNOWN1',
             description: 'NEFT CR SOMEBODY', status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART }],
  }));
  assert.ok(brief.needs_attention.some((i) => i.detail.includes('51,705.81')));
});

test('the template brief always fills every field the dashboard renders', () => {
  const brief = templateBrief(buildBriefFacts(result));
  for (const key of ['headline', 'state_of_the_month', 'needs_attention', 'biggest_single_risk']) {
    assert.ok(brief[key], `missing ${key}`);
  }
  assert.ok(brief.needs_attention.length >= 1 && brief.needs_attention.length <= 5);
  for (const item of brief.needs_attention) {
    assert.ok(['high', 'medium', 'low'].includes(item.severity));
    assert.doesNotMatch(`${item.title} ${item.detail}`, /undefined|NaN|\[object/);
  }
});

test('a model failure still produces a brief, marked as the template', async () => {
  const brief = await writeBrief(result, {
    client: { messages: { create: async () => { throw new Error('overloaded'); } } },
  });
  assert.equal(brief.source, 'template');
  assert.equal(brief.fallback_reason, 'overloaded');
  assert.ok(brief.headline);
});

test('a model refusal is treated as a failure, not as an empty brief', async () => {
  const brief = await writeBrief(result, {
    client: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } },
  });
  assert.equal(brief.source, 'template');
  assert.ok(brief.headline);
});

test('a model answer is passed through and labelled as the model', async () => {
  const payload = {
    headline: 'Rs 1,21,221.37 still needs a human.',
    state_of_the_month: 'Most of the month cleared.',
    needs_attention: [{ title: 'Chase the bank', detail: 'UTR HDFCN1 was short.', severity: 'high' }],
    biggest_single_risk: 'UTR HDFCN1.',
  };
  const brief = await writeBrief(result, {
    client: { messages: { create: async () => ({
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    }) } },
  });
  assert.equal(brief.source, 'llm');
  assert.equal(brief.headline, payload.headline);
  assert.equal(brief.needs_attention.length, 1);
});
