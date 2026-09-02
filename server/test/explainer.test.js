import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts, templateExplanation } from '../src/explain/explainer.js';
import { REASON, STATUS } from '../src/match/codes.js';

// An invoice can match its payment to the paise and still be flagged, because
// the settlement batch that paid it out was short-credited. The note has to
// describe the leg that actually broke — the earlier version told the
// invoice-vs-payment story here, which read as "booked at Rs 10,004.00 but
// Razorpay captured Rs 10,004.00".
test('a short-credited batch is explained as a batch problem, not an invoice one', () => {
  const row = {
    invoice_id: 'INV-0046', customer: 'Coastal Foods', date: '2026-08-17',
    ledger_amount: 1_000_400, payment_amount: 1_000_400, delta: 0,
    payment_id: 'pay_x', utr: 'HDFCN123', order_ref: 'order_x',
    status: STATUS.EXCEPTION, reason: REASON.AMOUNT_MISMATCH,
    leg_a: { status: STATUS.MATCHED }, leg_b: { status: STATUS.EXCEPTION },
  };
  const group = {
    utr: 'HDFCN123', payment_ids: ['pay_x', 'pay_y', 'pay_z'],
    expected_credit: 3_274_170, credited: 3_219_670, bank_txn_ids: ['TXN1'], status: STATUS.EXCEPTION,
  };

  const facts = buildFacts(row, { group });
  assert.equal(facts.failing_leg, 'settlement_to_bank');

  const note = templateExplanation(row, facts);
  assert.match(note.explanation, /HDFCN123/);
  assert.match(note.explanation, /32,741\.70/, 'names what Razorpay said it paid out');
  assert.match(note.explanation, /32,196\.70/, 'names what actually arrived');
  assert.doesNotMatch(note.explanation, /captured Rs 10,004\.00/,
    'must not claim the invoice and the payment disagree — they are identical');
});

test('a real ledger keying error is still explained against the payment', () => {
  const row = {
    invoice_id: 'INV-0064', customer: 'Lakshmi Silks', date: '2026-08-12',
    ledger_amount: 625_600, payment_amount: 793_500, delta: -167_900,
    payment_id: 'pay_q', order_ref: 'order_q', utr: 'HDFCN999',
    status: STATUS.EXCEPTION, reason: REASON.AMOUNT_MISMATCH,
    leg_a: { status: STATUS.EXCEPTION }, leg_b: { status: STATUS.MATCHED },
  };
  const facts = buildFacts(row, {});
  assert.equal(facts.failing_leg, 'ledger_to_payment');

  const note = templateExplanation(row, facts);
  assert.match(note.explanation, /6,256\.00/);
  assert.match(note.explanation, /7,935\.00/);
  assert.match(note.suggested_action, /pay_q/);
});

test('every reason code produces a note with all three fields', () => {
  // Nothing may reach the report without an explanation, an action and a severity.
  const row = {
    invoice_id: 'INV-0001', customer: 'Test Co', date: '2026-08-01',
    ledger_amount: 100_000, payment_amount: 100_000, payment_id: 'pay_1',
    utr: 'U1', order_ref: '', leg_a: { status: STATUS.EXCEPTION }, leg_b: null,
  };
  for (const reason of Object.values(REASON)) {
    const note = templateExplanation({ ...row, reason }, buildFacts({ ...row, reason }, {}));
    assert.ok(note.explanation?.length > 20, `${reason}: no explanation`);
    assert.ok(note.suggested_action?.length > 20, `${reason}: no action`);
    assert.ok(['high', 'medium', 'low'].includes(note.severity), `${reason}: bad severity`);
    assert.doesNotMatch(note.explanation, /undefined|NaN|\[object/, `${reason}: leaked a broken value`);
  }
});
