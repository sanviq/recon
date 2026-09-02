import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, toleranceFor, DEFAULT_CONFIG } from '../src/match/engine.js';
import { REASON, STATUS, RULE } from '../src/match/codes.js';
import { razorpayFees } from '../src/lib/money.js';

// Hand-built fixtures rather than generated ones. These tests assert the rules,
// so they must not be able to pass because the generator happened to agree.

let seq = 0;
const uid = (p) => `${p}${String(++seq).padStart(4, '0')}`;

function payment({ amount, date, utr, order_id = null, settled_date = null }) {
  const { fee, tax, net } = razorpayFees(amount);
  return {
    id: uid('pay_'), order_id, invoice_ref: null, customer: 'Test Co',
    amount, fee, tax, net, date, utr,
    settlement_id: utr ? `setl_${utr}` : null,
    settled_date: settled_date ?? date, settled: true,
  };
}

function ledgerRow({ amount, date, order_ref = '', invoice_id = uid('INV-') }) {
  return { invoice_id, order_ref, customer: 'Test Co', date, amount, currency: 'INR' };
}

function bankRow({ utr, credit, date }) {
  return { txn_id: uid('TXN'), date, utr, credit, debit: 0, description: `NEFT CR ${utr}` };
}

/** Builds a bank credit that exactly settles the given payments. */
function settlementCredit(payments, { date, utr }) {
  return bankRow({ utr, credit: payments.reduce((s, p) => s + p.net, 0), date });
}

const run = (ledger, payments, bank, config) =>
  reconcile({ dir: 'test', manifest: {}, truth: null, ledger, payments, bank, settlements: [] }, config);

const byInvoice = (result, id) => result.ledger.find((l) => l.invoice_id === id);

test('gateway reference is an identity claim and wins outright', () => {
  const p = payment({ amount: 250000, date: '2026-08-04', utr: 'UTR1', order_id: 'order_A' });
  const l = ledgerRow({ amount: 250000, date: '2026-08-03', order_ref: 'order_A' });
  const r = run([l], [p], [settlementCredit([p], { date: '2026-08-06', utr: 'UTR1' })]);

  const row = byInvoice(r, l.invoice_id);
  assert.equal(row.status, STATUS.MATCHED);
  assert.equal(row.rule, `${RULE.EXACT_REF}+${RULE.BATCH_EXACT}`);
  assert.equal(row.confidence, 1);
  assert.equal(row.payment_id, p.id);
});

test('a reference match with a wrong amount is an amount mismatch, not an unmatched row', () => {
  // Collapsing these two into "unmatched" is what makes real recon reports
  // useless: the row is positively identified, only the number is wrong.
  const p = payment({ amount: 250000, date: '2026-08-04', utr: 'UTR1', order_id: 'order_A' });
  const l = ledgerRow({ amount: 350000, date: '2026-08-03', order_ref: 'order_A' });
  const r = run([l], [p], [settlementCredit([p], { date: '2026-08-06', utr: 'UTR1' })]);

  const row = byInvoice(r, l.invoice_id);
  assert.equal(row.status, STATUS.EXCEPTION);
  assert.equal(row.reason, REASON.AMOUNT_MISMATCH);
  assert.equal(row.payment_id, p.id, 'the counterpart is still identified');
  assert.equal(row.delta, 100000);
});

test('sub-rupee drift is absorbed but a real keying error is not', () => {
  const p1 = payment({ amount: 250000, date: '2026-08-04', utr: 'UTR1' });
  const p2 = payment({ amount: 990000, date: '2026-08-04', utr: 'UTR1' });
  const drift = ledgerRow({ amount: 250063, date: '2026-08-04' });   // 63 paise off
  const typo = ledgerRow({ amount: 950000, date: '2026-08-04' });    // Rs 400 off
  const r = run([drift, typo], [p1, p2],
    [settlementCredit([p1, p2], { date: '2026-08-06', utr: 'UTR1' })]);

  assert.equal(byInvoice(r, drift.invoice_id).status, STATUS.MATCHED);
  assert.equal(byInvoice(r, drift.invoice_id).rule.startsWith(RULE.FUZZY_AMOUNT_DATE), true);
  assert.equal(byInvoice(r, typo.invoice_id).status, STATUS.EXCEPTION);
});

test('two identical candidates are reported as ambiguous, never guessed', () => {
  // The single most important safety property: money booked to the wrong
  // invoice is never found again, so refusing is always the right answer here.
  const p1 = payment({ amount: 500000, date: '2026-08-04', utr: 'UTR1' });
  const p2 = payment({ amount: 500000, date: '2026-08-04', utr: 'UTR1' });
  const l1 = ledgerRow({ amount: 500000, date: '2026-08-04' });
  const l2 = ledgerRow({ amount: 500000, date: '2026-08-04' });
  const r = run([l1, l2], [p1, p2],
    [settlementCredit([p1, p2], { date: '2026-08-06', utr: 'UTR1' })]);

  for (const l of [l1, l2]) {
    const row = byInvoice(r, l.invoice_id);
    assert.equal(row.status, STATUS.EXCEPTION);
    assert.equal(row.reason, REASON.AMBIGUOUS_CANDIDATES);
    assert.equal(row.payment_id, null);
    assert.equal(row.confidence, 0);
  }
});

test('one payment can never be claimed by two invoices', () => {
  const p = payment({ amount: 500000, date: '2026-08-04', utr: 'UTR1', order_id: 'order_A' });
  const withRef = ledgerRow({ amount: 500000, date: '2026-08-04', order_ref: 'order_A' });
  const without = ledgerRow({ amount: 500000, date: '2026-08-04' });
  const r = run([withRef, without], [p], [settlementCredit([p], { date: '2026-08-06', utr: 'UTR1' })]);

  assert.equal(byInvoice(r, withRef.invoice_id).payment_id, p.id, 'reference match wins the payment');
  assert.equal(byInvoice(r, without.invoice_id).status, STATUS.EXCEPTION);
  assert.equal(byInvoice(r, without.invoice_id).payment_id, null);

  const claims = r.ledger.filter((l) => l.payment_id === p.id);
  assert.equal(claims.length, 1);
});

test('many invoices settle under one UTR against a single bank credit', () => {
  // The batch match. Row-to-row matching cannot do this at all.
  const ps = [180000, 249900, 75000, 1200000].map((amount, i) =>
    payment({ amount, date: '2026-08-04', utr: 'UTR9', order_id: `order_${i}` }));
  const ls = ps.map((p, i) => ledgerRow({ amount: p.amount, date: '2026-08-04', order_ref: `order_${i}` }));
  const credit = settlementCredit(ps, { date: '2026-08-06', utr: 'UTR9' });
  const r = run(ls, ps, [credit]);

  assert.equal(r.summary.matched, 4);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].payment_ids.length, 4);
  assert.equal(r.groups[0].credited, credit.credit);
  // The credit is net of fees and GST, never the sum of the invoice amounts.
  assert.ok(credit.credit < ps.reduce((s, p) => s + p.amount, 0));
});

test('a payout split into tranches is matched, not called a duplicate', () => {
  const ps = [200000, 300000].map((amount, i) =>
    payment({ amount, date: '2026-08-04', utr: 'UTRS', order_id: `order_${i}` }));
  const ls = ps.map((p, i) => ledgerRow({ amount: p.amount, date: '2026-08-04', order_ref: `order_${i}` }));
  const total = ps.reduce((s, p) => s + p.net, 0);
  const first = Math.round(total * 0.6);
  const r = run(ls, ps, [
    bankRow({ utr: 'UTRS', credit: first, date: '2026-08-06' }),
    bankRow({ utr: 'UTRS', credit: total - first, date: '2026-08-07' }),
  ]);

  assert.equal(r.groups[0].status, STATUS.MATCHED);
  assert.equal(r.groups[0].rule, RULE.BATCH_SPLIT);
  assert.equal(r.summary.matched, 2);
});

test('a double-posted credit is flagged, because the cash position is overstated', () => {
  const p = payment({ amount: 500000, date: '2026-08-04', utr: 'UTRD', order_id: 'order_A' });
  const l = ledgerRow({ amount: 500000, date: '2026-08-04', order_ref: 'order_A' });
  const credit = settlementCredit([p], { date: '2026-08-06', utr: 'UTRD' });
  const r = run([l], [p], [credit, { ...credit, txn_id: uid('TXN') }]);

  assert.equal(r.groups[0].status, STATUS.EXCEPTION);
  assert.equal(r.groups[0].reason, REASON.DUPLICATE_UTR);
  assert.equal(r.groups[0].detail.overstated_by, credit.credit);
  // The invoice inherits the batch's problem: its money is not confirmed.
  assert.equal(byInvoice(r, l.invoice_id).status, STATUS.EXCEPTION);
  assert.equal(byInvoice(r, l.invoice_id).reason, REASON.DUPLICATE_UTR);
});

test('a late credit is flagged on the date even when the amount is right', () => {
  const p = payment({ amount: 500000, date: '2026-08-04', utr: 'UTRL' });
  const l = ledgerRow({ amount: 500000, date: '2026-08-04' });
  const r = run([l], [p], [settlementCredit([p], { date: '2026-08-20', utr: 'UTRL' })]);

  assert.equal(r.groups[0].reason, REASON.DATE_OUT_OF_WINDOW);
  assert.equal(byInvoice(r, l.invoice_id).reason, REASON.DATE_OUT_OF_WINDOW);
});

test('a settlement with no bank credit is never auto-cleared', () => {
  const p = payment({ amount: 500000, date: '2026-08-04', utr: 'UTRX', order_id: 'order_A' });
  const l = ledgerRow({ amount: 500000, date: '2026-08-04', order_ref: 'order_A' });
  const r = run([l], [p], []);

  assert.equal(r.groups[0].status, STATUS.EXCEPTION);
  assert.equal(r.groups[0].reason, REASON.MISSING_COUNTERPART);
  assert.equal(byInvoice(r, l.invoice_id).status, STATUS.EXCEPTION);
});

test('money arriving that the gateway never sent is still an exception', () => {
  // A reconciliation that only looks for what it expects will happily miss cash
  // it cannot account for.
  const p = payment({ amount: 500000, date: '2026-08-04', utr: 'UTR1', order_id: 'order_A' });
  const l = ledgerRow({ amount: 500000, date: '2026-08-04', order_ref: 'order_A' });
  const stray = bankRow({ utr: 'IMPS123456', credit: 4200000, date: '2026-08-08' });
  const r = run([l], [p], [settlementCredit([p], { date: '2026-08-06', utr: 'UTR1' }), stray]);

  const flagged = r.bank.find((b) => b.txn_id === stray.txn_id);
  assert.equal(flagged.status, STATUS.EXCEPTION);
  assert.equal(flagged.reason, REASON.MISSING_COUNTERPART);
  assert.equal(r.summary.bank_unexplained_credit_paise, 4200000);
});

test('an invoice with no payment at all reports a missing counterpart', () => {
  const l = ledgerRow({ amount: 500000, date: '2026-08-04' });
  const r = run([l], [], []);
  assert.equal(byInvoice(r, l.invoice_id).reason, REASON.MISSING_COUNTERPART);
});

test('every ledger row lands in exactly one bucket with a reason if flagged', () => {
  // Nothing may fall out of the report silently.
  const ps = [100000, 100000, 250000].map((amount) => payment({ amount, date: '2026-08-04', utr: 'UTR1' }));
  const ls = [
    ledgerRow({ amount: 100000, date: '2026-08-04' }),
    ledgerRow({ amount: 100000, date: '2026-08-04' }),
    ledgerRow({ amount: 999999, date: '2026-08-04' }),
  ];
  const r = run(ls, ps, [settlementCredit(ps, { date: '2026-08-06', utr: 'UTR1' })]);

  assert.equal(r.ledger.length, ls.length);
  for (const row of r.ledger) {
    assert.ok(row.status === STATUS.MATCHED || row.status === STATUS.EXCEPTION);
    if (row.status === STATUS.EXCEPTION) assert.ok(row.reason, `${row.invoice_id} has no reason code`);
  }
  assert.equal(r.summary.matched + r.summary.exceptions, ls.length);
});

test('the same input always produces the same decisions', () => {
  // Determinism is what makes the audit trail evidence rather than a report.
  const ps = [180000, 249900, 75000].map((amount, i) =>
    payment({ amount, date: '2026-08-04', utr: 'UTR1', order_id: i === 0 ? 'order_0' : null }));
  const ls = ps.map((p, i) => ledgerRow({ amount: p.amount, date: '2026-08-04', order_ref: i === 0 ? 'order_0' : '' }));
  const bank = [settlementCredit(ps, { date: '2026-08-06', utr: 'UTR1' })];

  const decisions = (r) => r.ledger.map((l) => `${l.invoice_id}:${l.status}:${l.reason}:${l.payment_id}`);
  assert.deepEqual(decisions(run(ls, ps, bank)), decisions(run(ls, ps, bank)));
});

test('every decision reaches the audit trail', () => {
  const ps = [180000, 249900].map((amount) => payment({ amount, date: '2026-08-04', utr: 'UTR1' }));
  const ls = ps.map((p) => ledgerRow({ amount: p.amount, date: '2026-08-04' }));
  const r = run(ls, ps, [settlementCredit(ps, { date: '2026-08-06', utr: 'UTR1' })]);

  for (const row of r.ledger) {
    assert.ok(
      r.audit.some((e) => e.subject_id === row.invoice_id),
      `no audit entry for ${row.invoice_id}`,
    );
  }
  // Sequence numbers are dense and ordered, so a removed line is detectable.
  assert.deepEqual(r.audit.map((e) => e.seq), r.audit.map((_, i) => i + 1));
});

test('tolerance is a floor for small amounts and a cap for large ones', () => {
  const t = DEFAULT_CONFIG.amountTolerance;
  assert.equal(toleranceFor(1000, t), t.floorPaise, 'tiny amounts get the flat floor');
  assert.equal(toleranceFor(100_000_000, t), t.capPaise, 'huge amounts do not get a huge blind spot');
  assert.ok(toleranceFor(10_000_000, t) > t.floorPaise);
});
