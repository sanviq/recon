import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts, templateExplanation, checkNoteAgainstFacts, explainOne } from '../src/explain/explainer.js';
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

// ---------------------------------------------------------------------------
// Grounding. The model is told to use only the figures it is given; this is what
// makes that a property of the system rather than a request in a prompt.
// ---------------------------------------------------------------------------

const FACTS = {
  invoice_id: 'INV-2026-0046',
  ledger_amount_rupees: '10,004.00',
  settlement_utr: 'HDFCN2608219874',
  matched_payment: { payment_id: 'pay_RabC123', captured_amount_rupees: '10,004.00' },
  settlement_batch: { utr: 'HDFCN2608219874', expected_credit_rupees: '32,741.70',
                      actually_credited_rupees: '32,196.70', bank_transactions: ['TXN202608170023'] },
};

test('a note built only from the supplied facts passes', () => {
  const g = checkNoteAgainstFacts({
    explanation: 'Payout HDFCN2608219874 credited Rs 32,196.70 against an expected Rs 32,741.70, and invoice INV-2026-0046 sits in that batch.',
    suggested_action: 'Compare bank transaction TXN202608170023 against payment pay_RabC123.',
  }, FACTS);
  assert.equal(g.ok, true);
  assert.deepEqual(g.unsupported_identifiers, []);
  assert.deepEqual(g.unsupported_amounts, []);
  assert.ok(g.checked.identifiers >= 4);
});

test('an invoice id that was never supplied is caught', () => {
  const g = checkNoteAgainstFacts({
    explanation: 'Invoice INV-2026-9999 is also affected.',
    suggested_action: 'Review it.',
  }, FACTS);
  assert.equal(g.ok, false);
  assert.deepEqual(g.unsupported_identifiers, ['INV-2026-9999']);
});

test('a UTR and a payment id that were never supplied are caught', () => {
  const g = checkNoteAgainstFacts({
    explanation: 'Payout ICICN9999999999 carried payment pay_NotReal.',
    suggested_action: 'Check it.',
  }, FACTS);
  assert.equal(g.ok, false);
  assert.deepEqual(g.unsupported_identifiers.sort(), ['ICICN9999999999', 'pay_NotReal']);
});

// A shortfall the model worked out itself is not invention, but it is arithmetic
// it was asked not to do — recorded, not suppressed.
test('a derived amount is flagged without discarding an otherwise good note', () => {
  const g = checkNoteAgainstFacts({
    explanation: 'The credit for HDFCN2608219874 was short by Rs 545.00.',
    suggested_action: 'Ask the bank about invoice INV-2026-0046.',
  }, FACTS);
  assert.equal(g.ok, true, 'an unverifiable amount must not throw away the note');
  assert.deepEqual(g.unsupported_amounts, ['545.00']);
});

test('ordinary finance words are not mistaken for invented references', () => {
  const g = checkNoteAgainstFacts({
    explanation: 'GST on the fee is already accounted for; the UTR is correct and NEFT was used.',
    suggested_action: 'No action beyond reviewing INV-2026-0046.',
  }, FACTS);
  assert.equal(g.ok, true);
  assert.deepEqual(g.unsupported_identifiers, []);
});

test('a hallucinated record makes the whole note fall back to the template', async () => {
  const row = {
    invoice_id: 'INV-0046', customer: 'Coastal Foods', date: '2026-08-17',
    ledger_amount: 1_000_400, payment_amount: 1_000_400, delta: 0,
    payment_id: 'pay_x', utr: 'HDFCN123', order_ref: 'order_x',
    status: STATUS.EXCEPTION, reason: REASON.AMOUNT_MISMATCH,
    leg_a: { status: STATUS.MATCHED }, leg_b: { status: STATUS.EXCEPTION },
  };
  const client = { messages: { create: async () => ({
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: JSON.stringify({
      explanation: 'Invoice INV-2026-7777 was short-paid under UTR ICICN0000000001.',
      suggested_action: 'Call the bank.', severity: 'high',
    }) }],
  }) } };

  const note = await explainOne(client, row, {
    group: { utr: 'HDFCN123', payment_ids: ['pay_x'], expected_credit: 3_274_170,
             credited: 3_219_670, bank_txn_ids: ['TXN1'], status: STATUS.EXCEPTION },
  });

  assert.equal(note.source, 'template', 'an invented record must not reach the report');
  assert.match(note.fallback_reason, /INV-2026-7777/);
  assert.match(note.fallback_reason, /ICICN0000000001/);
  assert.doesNotMatch(note.explanation, /7777/, 'and the fabricated id must be gone from the output');
});

test('a well-grounded model note is kept, and carries its grounding record', async () => {
  const row = {
    invoice_id: 'INV-0046', ledger_amount: 1_000_400, payment_id: 'pay_x', utr: 'HDFCN123',
    status: STATUS.EXCEPTION, reason: REASON.AMOUNT_MISMATCH,
    leg_a: { status: STATUS.MATCHED }, leg_b: { status: STATUS.EXCEPTION },
  };
  const client = { messages: { create: async () => ({
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: JSON.stringify({
      explanation: 'The payout under HDFCN123 did not fully reach the bank.',
      suggested_action: 'Ask the bank about invoice INV-0046.', severity: 'medium',
    }) }],
  }) } };

  const note = await explainOne(client, row, {
    group: { utr: 'HDFCN123', payment_ids: ['pay_x'], expected_credit: 3_274_170,
             credited: 3_219_670, bank_txn_ids: ['TXN1'], status: STATUS.EXCEPTION },
  });
  assert.equal(note.source, 'llm');
  assert.equal(note.grounding.ok, true);
});
