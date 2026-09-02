// Builds the two merchant-side sources around a spine of real Razorpay payments.
//
// The gateway is the only party that knows what it captured and which UTR paid
// it out, so those come from the API. The merchant's ledger and their bank
// statement are ours to construct — which is the honest arrangement anyway,
// since no hackathon has access to a real merchant's books or bank feed.
//
// The faults injected here are the same ones the fully synthetic generator uses,
// so a run against live payments is scored by exactly the same rules.

import { makeRng } from '../lib/rng.js';
import { addDays } from '../lib/dates.js';
import { RUPEE } from '../lib/money.js';
import { REASON, STATUS } from '../match/codes.js';
import { DEFAULT_FAULTS, PROFILES } from './synth.js';
import { buildBankStatement, bankTruth } from './bank.js';

const CUSTOMERS = [
  'Meera Textiles', 'Anand Traders', 'Kavya Organics', 'Rohit Electronics',
  'Sunrise Stationers', 'Deccan Spice Co', 'Nimbus Softworks', 'Patel Hardware',
];

/**
 * @param {object[]} payments    normalised Razorpay payments (see sources/razorpay.js)
 * @param {object[]} settlements settlements with payment_ids attached
 */
export function buildCounterparts(payments, settlements, { seed = 7, profile = 'standard', faults = {} } = {}) {
  const f = { ...DEFAULT_FAULTS, ...(PROFILES[profile] ?? {}), ...faults };
  const rng = makeRng(seed);

  const settlementByPayment = new Map();
  for (const s of settlements) for (const pid of s.payment_ids) settlementByPayment.set(pid, s);

  // --- which real payments the merchant never wrote an invoice for
  const shuffled = rng.shuffle(payments);
  const unrecorded = new Set(shuffled.slice(0, Math.min(f.unrecordedPayments, payments.length - 1)).map((p) => p.id));
  const invoiced = payments.filter((p) => !unrecorded.has(p.id));

  // --- ledger-side amount faults, drawn disjointly from the invoiced payments
  const pool = rng.shuffle(invoiced);
  let cursor = 0;
  const take = (n) => new Set(pool.slice(cursor, (cursor += Math.min(n, Math.max(0, pool.length - cursor)))).map((p) => p.id));
  const driftIds = take(f.ledgerDriftSmall);
  const typoIds = take(f.ledgerTypoLarge);

  // --- the merchant's book, one row per invoiced payment
  const ledger = [];
  const truthRows = [];
  invoiced.forEach((p, i) => {
    const drift = driftIds.has(p.id);
    const typo = typoIds.has(p.id);
    // A keying error does not erase the order id, so a typo row keeps its
    // reference and is provably wrong rather than merely unmatched.
    const keepRef = Boolean(p.order_id) && (typo || (!drift && rng.float() >= f.blankRefRatio));

    let amount = p.amount;
    if (drift) amount += (rng.chance(0.5) ? 1 : -1) * rng.int(1, 90);
    if (typo) amount += (rng.chance(0.5) ? 1 : -1) * rng.int(400, 2_500) * RUPEE;

    const invoiceId = p.notes?.invoice_ref ?? `INV-${String(i + 1).padStart(4, '0')}`;
    // Customers do not pay the instant an invoice is raised, so the book date
    // sits a little before the capture date.
    const invoiceDate = addDays(p.captured_date, -(rng.chance(0.35) ? rng.int(1, 2) : 0));

    ledger.push({
      invoice_id: invoiceId,
      order_ref: keepRef ? p.order_id : '',
      customer: p.notes?.customer ?? rng.pick(CUSTOMERS),
      invoice_date: invoiceDate,
      amount,
      currency: p.currency ?? 'INR',
      status: 'paid',
    });

    truthRows.push({
      invoice_id: invoiceId,
      payment_id: p.id,
      settlement_id: settlementByPayment.get(p.id)?.id ?? null,
      utr: settlementByPayment.get(p.id)?.utr ?? null,
      fault: typo ? 'ledger_amount_typo' : drift ? 'ledger_amount_drift' : null,
    });
  });

  // --- invoices the merchant settled outside the gateway entirely: cash,
  // cheque, a direct transfer. They belong in the book and have no payment.
  const amounts = payments.map((p) => p.amount).sort((a, b) => a - b);
  const median = amounts[Math.floor(amounts.length / 2)] ?? 100_000;
  const dates = payments.map((p) => p.captured_date).sort();
  for (let i = 0; i < f.offlineInvoices; i++) {
    const invoiceId = `INV-OFF-${String(i + 1).padStart(3, '0')}`;
    ledger.push({
      invoice_id: invoiceId,
      order_ref: '',
      customer: rng.pick(CUSTOMERS),
      invoice_date: rng.pick(dates) ?? '2026-08-05',
      amount: Math.round(median * (0.5 + rng.float())),
      currency: 'INR',
      status: 'paid',
    });
    truthRows.push({ invoice_id: invoiceId, payment_id: null, settlement_id: null, utr: null, fault: 'offline_invoice' });
  }

  ledger.sort((a, b) => a.invoice_date.localeCompare(b.invoice_date) || a.invoice_id.localeCompare(b.invoice_id));

  // --- the bank statement, built by the same builder the synthetic path uses
  const { bank, settlementFaults, settlementReason } = buildBankStatement(settlements, { rng, faults: f });

  // --- ground truth
  const truthByInvoice = new Map(truthRows.map((t) => [t.invoice_id, t]));
  const ledgerTruth = ledger.map((row) => {
    const t = truthByInvoice.get(row.invoice_id);
    const base = { invoice_id: row.invoice_id, payment_id: t.payment_id, utr: t.utr };
    if (t.fault === 'offline_invoice') {
      return { ...base, status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART, fault: t.fault };
    }
    if (t.fault === 'ledger_amount_typo') {
      return { ...base, status: STATUS.EXCEPTION, reason: REASON.AMOUNT_MISMATCH, fault: t.fault };
    }
    if (!t.settlement_id) {
      // Captured but not yet paid out — real and common in test mode, and the
      // correct answer is "not confirmed", not "matched".
      return { ...base, status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART, fault: 'unsettled_payment' };
    }
    const tainted = settlementReason.get(t.settlement_id);
    return tainted
      ? { ...base, status: STATUS.EXCEPTION, reason: tainted, fault: `settlement_${settlementFaults.get(t.settlement_id)}` }
      : { ...base, status: STATUS.MATCHED, reason: null, fault: null };
  });

  const paymentTruth = payments.map((p) => {
    const s = settlementByPayment.get(p.id);
    if (unrecorded.has(p.id)) {
      return { payment_id: p.id, status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART,
               utr: s?.utr ?? null, fault: 'unrecorded_payment' };
    }
    const tainted = s ? settlementReason.get(s.id) : REASON.MISSING_COUNTERPART;
    return tainted
      ? { payment_id: p.id, status: STATUS.EXCEPTION, reason: tainted, utr: s?.utr ?? null,
          fault: s ? `settlement_${settlementFaults.get(s.id)}` : 'unsettled_payment' }
      : { payment_id: p.id, status: STATUS.MATCHED, reason: null, utr: s.utr, fault: null };
  });

  const bankRows = bankTruth(bank, settlementReason);

  return {
    ledger,
    bank,
    truth: {
      ledger: ledgerTruth,
      payments: paymentTruth,
      bank: bankRows,
      summary: {
        ledger_matched: ledgerTruth.filter((t) => t.status === STATUS.MATCHED).length,
        ledger_exceptions: ledgerTruth.filter((t) => t.status === STATUS.EXCEPTION).length,
        bank_matched: bankRows.filter((t) => t.status === STATUS.MATCHED).length,
        bank_exceptions: bankRows.filter((t) => t.status === STATUS.EXCEPTION).length,
        settlements: settlements.length,
      },
    },
    faults: f,
    // Amount/date collisions are absent from the live path for an honest reason:
    // they require forcing two payments to the same amount on the same day, and
    // real payments cannot be edited. The synthetic profiles cover that case.
    notes: ['no injected amount/date collisions — real payment amounts cannot be forced'],
  };
}
