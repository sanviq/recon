// Synthetic dataset generator.
//
// Produces a merchant-month across three sources that a real finance team would
// actually hold, plus a ground-truth file saying what the correct answer is for
// every single record. The ground truth is what makes the accuracy numbers in the
// README checkable instead of asserted.
//
// The faults injected here are not random noise. Each one is a failure mode that
// shows up in real Razorpay reconciliation:
//   - one bank credit covers many invoices (settlement batching) — the default,
//     not a fault, but the reason naive row-to-row matching fails immediately
//   - the bank credit is amount - fee - GST, never the invoice amount
//   - credits land T+2..T+5, so same-day matching finds nothing
//   - the merchant ledger often has no gateway reference at all
//   - banks occasionally double-post a credit
//   - money arrives that the gateway never sent (other PSP, manual transfer)

import { makeRng } from '../lib/rng.js';
import { addDays, isoToUnix } from '../lib/dates.js';
import { razorpayFees, RUPEE } from '../lib/money.js';
import { REASON, STATUS } from '../match/codes.js';

const CUSTOMERS = [
  'Meera Textiles', 'Anand Traders', 'Kavya Organics', 'Rohit Electronics',
  'Sunrise Stationers', 'Deccan Spice Co', 'Nimbus Softworks', 'Patel Hardware',
  'Lakshmi Silks', 'Verma Auto Parts', 'Coastal Foods', 'Aarav Print House',
];

const METHODS = ['upi', 'card', 'netbanking', 'wallet', 'upi', 'upi', 'card'];
const BANK_PREFIXES = ['CITIN', 'HDFCN', 'ICICN', 'AXISN'];

/**
 * Fault budget. Explicit counts, not probabilities — the ground truth has to be
 * exact for the metrics to mean anything, and "roughly three duplicates" is not
 * a testable statement.
 */
export const DEFAULT_FAULTS = {
  offlineInvoices: 4,        // in ledger, never went through Razorpay
  unrecordedPayments: 3,     // in Razorpay, merchant never raised an invoice
  ledgerDriftSmall: 5,       // ledger amount off by rounding — should still match
  ledgerTypoLarge: 3,        // ledger amount wrong enough to be a real exception
  collisionPairs: 2,         // same amount, same day, no reference — ambiguous
  blankRefRatio: 0.45,       // share of ledger rows with no gateway reference
  lateSettlements: 1,        // bank credit lands outside the lag window
  shortCredits: 1,           // bank deducted something the gateway did not report
  duplicateCredits: 1,       // bank double-posted a credit
  orphanCredits: 2,          // credit with a UTR Razorpay never issued
};

export function generateDataset({
  seed = 7,
  invoiceCount = 72,
  monthStart = '2026-08-03',
  days = 22,
  settlementLagDays = 2,
  faults = {},
} = {}) {
  const f = { ...DEFAULT_FAULTS, ...faults };
  const rng = makeRng(seed);
  const idTag = (n, width = 6) => String(n).padStart(width, '0');

  // ---------------------------------------------------------------- invoices
  const invoices = [];
  for (let i = 0; i < invoiceCount; i++) {
    const day = rng.int(0, days - 1);
    // Long-tail amounts: mostly small-ticket, a few large ones. A flat
    // distribution would make amount-based matching unrealistically easy
    // because collisions would almost never happen.
    const bucket = rng.float();
    const rupees =
      bucket < 0.6 ? rng.int(199, 2_499)
      : bucket < 0.9 ? rng.int(2_500, 24_999)
      : rng.int(25_000, 180_000);

    invoices.push({
      invoice_id: `INV-2026-${idTag(i + 1, 4)}`,
      order_ref: `order_R${idTag(seed * 1000 + i, 8)}`,
      customer: rng.pick(CUSTOMERS),
      invoice_date: addDays(monthStart, day),
      amount: rupees * RUPEE + (rng.chance(0.5) ? rng.int(0, 99) : 0),
    });
  }
  invoices.sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));

  // -------------------------------------------------- deliberate collisions
  // Two invoices, same day, same amount, both with the reference stripped. The
  // engine cannot legitimately tell them apart and must say so rather than
  // guessing — this is the case that separates an honest matcher from a lucky one.
  const collisionIds = new Set();
  for (let c = 0; c < f.collisionPairs; c++) {
    const i = rng.int(0, invoices.length - 2);
    const a = invoices[i];
    const b = invoices[i + 1];
    if (collisionIds.has(a.invoice_id) || collisionIds.has(b.invoice_id)) continue;
    b.invoice_date = a.invoice_date;
    b.amount = a.amount;
    collisionIds.add(a.invoice_id);
    collisionIds.add(b.invoice_id);
  }

  // ------------------------------------------------------ fault assignment
  // Disjoint sets, drawn from invoices not already used as collision bait.
  const eligible = rng.shuffle(invoices.filter((i) => !collisionIds.has(i.invoice_id)));
  let cursor = 0;
  const take = (n) => eligible.slice(cursor, (cursor += n)).map((i) => i.invoice_id);

  const offlineIds = new Set(take(f.offlineInvoices));
  const driftSmallIds = new Set(take(f.ledgerDriftSmall));
  const typoLargeIds = new Set(take(f.ledgerTypoLarge));

  // ---------------------------------------------------------------- payments
  const payments = [];
  const paymentByInvoice = new Map();
  invoices.forEach((inv, i) => {
    if (offlineIds.has(inv.invoice_id)) return; // paid by cash/cheque, no gateway record
    const { fee, tax, net } = razorpayFees(inv.amount);
    const capturedAt = isoToUnix(inv.invoice_date) + rng.int(8 * 3600, 21 * 3600);
    const p = {
      id: `pay_R${idTag(seed * 1000 + i, 8)}`,
      entity: 'payment',
      amount: inv.amount,
      currency: 'INR',
      status: 'captured',
      order_id: inv.order_ref,
      method: rng.pick(METHODS),
      captured: true,
      description: `Invoice ${inv.invoice_id}`,
      fee,
      tax,
      net,
      created_at: capturedAt,
      captured_date: inv.invoice_date,
      notes: { invoice_ref: inv.invoice_id, customer: inv.customer },
    };
    payments.push(p);
    paymentByInvoice.set(inv.invoice_id, p);
  });

  // Payments with no invoice behind them: the merchant took the money but never
  // raised the paperwork. Shows up as revenue in the bank with nothing to book
  // it against.
  for (let i = 0; i < f.unrecordedPayments; i++) {
    const day = rng.int(0, days - 1);
    const amount = rng.int(500, 40_000) * RUPEE;
    const { fee, tax, net } = razorpayFees(amount);
    const date = addDays(monthStart, day);
    payments.push({
      id: `pay_U${idTag(seed * 1000 + i, 8)}`,
      entity: 'payment',
      amount,
      currency: 'INR',
      status: 'captured',
      order_id: null,
      method: rng.pick(METHODS),
      captured: true,
      description: 'Payment link',
      fee,
      tax,
      net,
      created_at: isoToUnix(date) + rng.int(8 * 3600, 21 * 3600),
      captured_date: date,
      notes: {},
      _unrecorded: true,
    });
  }
  payments.sort((a, b) => a.created_at - b.created_at);

  // ------------------------------------------------------------ settlements
  // Razorpay batches every payment captured on a day into one settlement paid
  // T+settlementLagDays. One UTR, many payments — this is why the merchant's
  // bank statement can never be matched to invoices one row at a time.
  const byPayoutDate = new Map();
  for (const p of payments) {
    const payoutDate = addDays(p.captured_date, settlementLagDays);
    if (!byPayoutDate.has(payoutDate)) byPayoutDate.set(payoutDate, []);
    byPayoutDate.get(payoutDate).push(p);
  }

  const settlements = [];
  [...byPayoutDate.keys()].sort().forEach((payoutDate, i) => {
    const members = byPayoutDate.get(payoutDate);
    settlements.push({
      id: `setl_R${idTag(seed * 100 + i, 8)}`,
      entity: 'settlement',
      amount: members.reduce((s, p) => s + p.net, 0),
      status: 'processed',
      fees: members.reduce((s, p) => s + p.fee, 0),
      tax: members.reduce((s, p) => s + p.tax, 0),
      utr: `${rng.pick(BANK_PREFIXES)}${payoutDate.replace(/-/g, '').slice(2)}${idTag(rng.int(1, 9999), 4)}`,
      created_at: isoToUnix(payoutDate) + 11 * 3600,
      settled_date: payoutDate,
      payment_ids: members.map((p) => p.id),
    });
  });

  const settlementByPayment = new Map();
  for (const s of settlements) {
    for (const pid of s.payment_ids) settlementByPayment.set(pid, s);
  }

  // ------------------------------------- settlement recon report (API shape)
  // Mirrors razorpay.settlements.reports() — one transaction-level row per
  // payment, carrying the UTR of the settlement that paid it out.
  const reconRows = payments.map((p) => {
    const s = settlementByPayment.get(p.id);
    return {
      entity_id: p.id,
      type: 'payment',
      debit: 0,
      credit: p.net,
      amount: p.amount,
      currency: 'INR',
      fee: p.fee,
      tax: p.tax,
      on_hold: false,
      settled: true,
      created_at: p.created_at,
      settled_at: s.created_at,
      settlement_id: s.id,
      settlement_utr: s.utr,
      order_id: p.order_id,
      payment_id: p.id,
      description: p.description,
      notes: p.notes,
    };
  });

  // ------------------------------------------------- settlement-side faults
  const settlementFaults = new Map(); // settlement.id -> fault tag
  const pickSettlements = (n, predicate = () => true) =>
    rng.shuffle(settlements.filter((s) => !settlementFaults.has(s.id) && predicate(s))).slice(0, n);

  // Keep the disruptive faults on small batches so one injected fault does not
  // blow up a third of the dataset and distort the headline match rate.
  const isSmall = (s) => s.payment_ids.length <= 4;
  for (const s of pickSettlements(f.lateSettlements, isSmall)) settlementFaults.set(s.id, 'late');
  for (const s of pickSettlements(f.duplicateCredits, isSmall)) settlementFaults.set(s.id, 'duplicate');
  for (const s of pickSettlements(f.shortCredits)) settlementFaults.set(s.id, 'short');

  // ------------------------------------------------------------------- bank
  const bank = [];
  let balance = 4_25_000 * RUPEE;
  let txnSeq = 0;
  const nextTxnId = (d) => `TXN${d.replace(/-/g, '')}${idTag(++txnSeq, 4)}`;

  for (const s of settlements) {
    const fault = settlementFaults.get(s.id);
    // A late credit is late in the bank, not in the gateway: Razorpay says it
    // paid on T+2, the money shows up on T+9.
    const creditDate = fault === 'late' ? addDays(s.settled_date, rng.int(6, 9)) : s.settled_date;
    // Short credit models a bank-side deduction the gateway never reported.
    const shortfall = fault === 'short' ? rng.int(150, 900) * RUPEE : 0;
    const credit = s.amount - shortfall;

    balance += credit;
    bank.push({
      txn_id: nextTxnId(creditDate),
      value_date: creditDate,
      description: `NEFT CR RAZORPAY SOFTWARE PVT LTD ${s.utr}`,
      utr: s.utr,
      credit,
      debit: 0,
      balance,
      _settlement_id: s.id,
      _fault: fault ?? null,
    });

    if (fault === 'duplicate') {
      // Same UTR posted twice. The cash position is now wrong by one settlement
      // and no automated rule should be trusted to decide which row is real.
      balance += credit;
      bank.push({
        txn_id: nextTxnId(creditDate),
        value_date: creditDate,
        description: `NEFT CR RAZORPAY SOFTWARE PVT LTD ${s.utr}`,
        utr: s.utr,
        credit,
        debit: 0,
        balance,
        _settlement_id: s.id,
        _fault: 'duplicate',
      });
    }
  }

  // Credits Razorpay never sent — another PSP, a manual transfer, a customer
  // paying by direct bank transfer.
  for (let i = 0; i < f.orphanCredits; i++) {
    const date = addDays(monthStart, rng.int(2, days));
    const credit = rng.int(2_000, 60_000) * RUPEE;
    balance += credit;
    bank.push({
      txn_id: nextTxnId(date),
      value_date: date,
      description: `IMPS CR CUSTOMER TRANSFER`,
      utr: `IMPS${date.replace(/-/g, '').slice(2)}${idTag(rng.int(1, 9999), 4)}`,
      credit,
      debit: 0,
      balance,
      _settlement_id: null,
      _fault: 'orphan',
    });
  }
  bank.sort((a, b) => a.value_date.localeCompare(b.value_date) || a.txn_id.localeCompare(b.txn_id));

  // ----------------------------------------------------------------- ledger
  // The merchant's own book. Deliberately the messiest of the three: nearly half
  // the rows have no gateway reference, and a handful of amounts are wrong.
  const ledger = invoices.map((inv) => {
    const row = {
      invoice_id: inv.invoice_id,
      order_ref: rng.float() < f.blankRefRatio || collisionIds.has(inv.invoice_id) ? '' : inv.order_ref,
      customer: inv.customer,
      invoice_date: inv.invoice_date,
      amount: inv.amount,
      currency: 'INR',
      status: 'paid',
    };
    if (driftSmallIds.has(inv.invoice_id)) {
      // Rounding the merchant did by hand. Small enough that a tolerant matcher
      // should still resolve it — this tests that fuzzy matching earns its keep.
      row.amount = inv.amount + (rng.chance(0.5) ? 1 : -1) * rng.int(1, 60);
    }
    if (typoLargeIds.has(inv.invoice_id)) {
      // A real keying error. Must surface as an exception, not be quietly absorbed.
      row.amount = inv.amount + (rng.chance(0.5) ? 1 : -1) * rng.int(400, 2_500) * RUPEE;
    }
    return row;
  });

  // ----------------------------------------------------------- ground truth
  const truth = buildTruth({
    ledger, invoices, payments, settlements, bank,
    paymentByInvoice, settlementByPayment, settlementFaults,
    offlineIds, typoLargeIds, driftSmallIds, collisionIds,
  });

  return {
    manifest: {
      seed, invoiceCount, monthStart, days, settlementLagDays,
      faults: f,
      generated_at: new Date().toISOString(),
      counts: {
        ledger: ledger.length,
        payments: payments.length,
        settlements: settlements.length,
        recon_rows: reconRows.length,
        bank: bank.length,
      },
    },
    ledger,
    payments,
    settlements,
    reconRows,
    bank,
    truth,
  };
}

/**
 * The correct answer for every record, derived from how the data was built
 * rather than from anything the matcher does. This file is never shown to the
 * engine — it exists only to score it.
 */
function buildTruth(ctx) {
  const {
    ledger, payments, settlements, bank,
    paymentByInvoice, settlementByPayment, settlementFaults,
    offlineIds, typoLargeIds, collisionIds,
  } = ctx;

  // A settlement whose bank leg is broken taints every invoice inside it: the
  // invoice is genuinely unconfirmed until a human resolves the batch.
  const settlementReason = new Map();
  for (const [sid, fault] of settlementFaults) {
    settlementReason.set(
      sid,
      fault === 'late' ? REASON.DATE_OUT_OF_WINDOW
        : fault === 'duplicate' ? REASON.DUPLICATE_UTR
        : REASON.AMOUNT_MISMATCH,
    );
  }

  const ledgerTruth = ledger.map((row) => {
    const base = { invoice_id: row.invoice_id };
    if (offlineIds.has(row.invoice_id)) {
      return { ...base, status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART,
        payment_id: null, utr: null, fault: 'offline_invoice' };
    }
    const payment = paymentByInvoice.get(row.invoice_id);
    const settlement = settlementByPayment.get(payment.id);
    if (typoLargeIds.has(row.invoice_id)) {
      return { ...base, status: STATUS.EXCEPTION, reason: REASON.AMOUNT_MISMATCH,
        payment_id: payment.id, utr: settlement.utr, fault: 'ledger_amount_typo' };
    }
    if (collisionIds.has(row.invoice_id)) {
      return { ...base, status: STATUS.EXCEPTION, reason: REASON.AMBIGUOUS_CANDIDATES,
        payment_id: payment.id, utr: settlement.utr, fault: 'amount_date_collision' };
    }
    const tainted = settlementReason.get(settlement.id);
    if (tainted) {
      return { ...base, status: STATUS.EXCEPTION, reason: tainted,
        payment_id: payment.id, utr: settlement.utr, fault: `settlement_${settlementFaults.get(settlement.id)}` };
    }
    return { ...base, status: STATUS.MATCHED, reason: null,
      payment_id: payment.id, utr: settlement.utr, fault: null };
  });

  const paymentTruth = payments.map((p) => {
    const s = settlementByPayment.get(p.id);
    if (p._unrecorded) {
      return { payment_id: p.id, status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART,
        utr: s.utr, fault: 'unrecorded_payment' };
    }
    const tainted = settlementReason.get(s.id);
    return tainted
      ? { payment_id: p.id, status: STATUS.EXCEPTION, reason: tainted, utr: s.utr, fault: `settlement_${settlementFaults.get(s.id)}` }
      : { payment_id: p.id, status: STATUS.MATCHED, reason: null, utr: s.utr, fault: null };
  });

  const bankTruth = bank.map((b) => {
    if (b._fault === 'orphan') {
      return { txn_id: b.txn_id, status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART,
        settlement_id: null, fault: 'orphan_credit' };
    }
    const reason = settlementReason.get(b._settlement_id);
    return reason
      ? { txn_id: b.txn_id, status: STATUS.EXCEPTION, reason, settlement_id: b._settlement_id, fault: `settlement_${b._fault}` }
      : { txn_id: b.txn_id, status: STATUS.MATCHED, reason: null, settlement_id: b._settlement_id, fault: null };
  });

  return {
    ledger: ledgerTruth,
    payments: paymentTruth,
    bank: bankTruth,
    summary: {
      ledger_matched: ledgerTruth.filter((t) => t.status === STATUS.MATCHED).length,
      ledger_exceptions: ledgerTruth.filter((t) => t.status === STATUS.EXCEPTION).length,
      bank_matched: bankTruth.filter((t) => t.status === STATUS.MATCHED).length,
      bank_exceptions: bankTruth.filter((t) => t.status === STATUS.EXCEPTION).length,
      settlements: settlements.length,
    },
  };
}
