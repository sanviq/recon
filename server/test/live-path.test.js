import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSettlements, reconRowsFrom, linkSettlements } from '../src/sources/razorpay.js';
import { buildCounterparts } from '../src/generate/fromPayments.js';
import { ledgerCSV, bankCSV } from '../src/generate/serialize.js';
import { parseCSV } from '../src/lib/csv.js';
import { normaliseLedger, normaliseBank, normalisePayments } from '../src/sources/load.js';
import { reconcile } from '../src/match/engine.js';
import { evaluate } from '../src/eval/score.js';
import { razorpayFees } from '../src/lib/money.js';
import { isoToUnix, addDays } from '../src/lib/dates.js';

// Exercises the Razorpay path end to end without needing credentials, by
// standing in a fake API response where the live client would return one.
// Everything after fetchPayments() is the same code the live pull runs.

function apiPayments(count, startDate = '2026-08-03') {
  return Array.from({ length: count }, (_, i) => {
    const amount = 50_000 + i * 7_351;
    const { fee, tax, net } = razorpayFees(amount);
    const date = addDays(startDate, i % 12);
    return {
      id: `pay_LIVE${String(i).padStart(4, '0')}`,
      entity: 'payment', amount, currency: 'INR', status: 'captured',
      order_id: i % 3 === 0 ? null : `order_LIVE${String(i).padStart(4, '0')}`,
      method: 'upi', captured: true, description: '',
      fee, tax, net,
      created_at: isoToUnix(date) + 40_000,
      captured_date: date,
      notes: {},
    };
  });
}

test('a payout schedule derived in test mode still batches many payments into one UTR', () => {
  // Test mode does not run a real settlement cycle, so this is the path an
  // actual test-mode pull takes almost every time.
  const payments = apiPayments(30);
  const settlements = deriveSettlements(payments);

  assert.ok(settlements.length > 1);
  assert.ok(settlements.some((s) => s.payment_ids.length > 1), 'settlements must batch');
  assert.equal(settlements.every((s) => s.derived === true), true, 'derived payouts must be flagged');
  // Never disguised as a bank UTR — a reader can see it did not come from Razorpay.
  assert.equal(settlements.every((s) => s.utr.startsWith('DERIVED')), true);

  for (const s of settlements) {
    const members = payments.filter((p) => s.payment_ids.includes(p.id));
    assert.equal(s.amount, members.reduce((sum, p) => sum + p.net, 0), 'payout is net of fees and GST');
    assert.ok(s.amount < members.reduce((sum, p) => sum + p.amount, 0));
  }
  assert.equal(settlements.reduce((n, s) => n + s.payment_ids.length, 0), payments.length);
});

test('recon rows carry the UTR that links a payment to its bank credit', () => {
  const payments = apiPayments(12);
  const settlements = deriveSettlements(payments);
  const rows = reconRowsFrom(payments, settlements);

  assert.equal(rows.length, payments.length);
  for (const r of rows) {
    assert.ok(r.settlement_utr, 'every recon row needs a UTR or the bank leg has no join key');
    assert.equal(r.credit, r.amount - r.fee - r.tax);
  }

  // linkSettlements must reconstruct the same grouping from the report alone,
  // which is what the live path does when the API does return settlements.
  const relinked = linkSettlements(settlements.map((s) => ({ ...s, payment_ids: [] })), rows);
  for (const s of relinked) {
    assert.deepEqual(
      s.payment_ids.sort(),
      settlements.find((x) => x.id === s.id).payment_ids.sort(),
    );
  }
});

test('live-pulled payments reconcile through the identical pipeline', () => {
  const payments = apiPayments(40);
  const settlements = deriveSettlements(payments);
  const reconRows = reconRowsFrom(payments, settlements);
  const { ledger, bank, truth } = buildCounterparts(payments, settlements, { seed: 11 });

  // Round-trip the merchant sources through CSV exactly as the on-disk run does.
  const dataset = {
    dir: 'test/live', manifest: {}, truth,
    ledger: normaliseLedger(parseCSV(ledgerCSV(ledger))),
    bank: normaliseBank(parseCSV(bankCSV(bank))),
    payments: normalisePayments(reconRows, payments, settlements),
    settlements,
  };

  const result = reconcile(dataset);
  const report = evaluate(dataset, result, 1);

  assert.equal(result.ledger.length, ledger.length);
  assert.ok(result.summary.matched > 0, 'the live path must actually match things');
  // The safety property has to hold here too, not just on synthetic data.
  assert.equal(report.accuracy.misrouted_matches, 0);
  assert.equal(report.accuracy.precision_auto_matched, 1);
  for (const row of result.ledger) {
    if (row.status === 'exception') assert.ok(row.reason, `${row.invoice_id} flagged with no reason`);
  }
});

test('the ledger built around real payments is deliberately imperfect', () => {
  // If the generated ledger were a clean mirror of the payments there would be
  // nothing to reconcile and the accuracy numbers would be meaningless.
  const payments = apiPayments(40);
  const settlements = deriveSettlements(payments);
  const { ledger, truth } = buildCounterparts(payments, settlements, { seed: 11 });

  assert.ok(ledger.some((r) => r.order_ref === ''), 'some rows must lack a gateway reference');
  assert.ok(ledger.some((r) => r.invoice_id.startsWith('INV-OFF-')), 'some invoices never hit the gateway');
  assert.ok(truth.ledger.some((t) => t.fault === 'ledger_amount_typo'));
  assert.ok(truth.payments.some((t) => t.fault === 'unrecorded_payment'));
  assert.equal(truth.ledger.length, ledger.length);
});
