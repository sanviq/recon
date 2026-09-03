// What the alternatives actually score.
//
// "100% precision" means nothing on its own. Precision compared to what? Every
// design decision in the engine — two legs, global passes, refusing ambiguity,
// verifying the payout against the bank — costs match rate. This file builds the
// two things a merchant would plausibly have instead, so that cost can be
// measured rather than asserted.
//
// Both baselines are scored by the same evaluate() against the same ground truth,
// on the same data, in the same run. Neither is a straw man: the first is what
// finance teams genuinely do today, and the second is what a careful engineer
// builds on day one before discovering how Razorpay settlements actually work.

import { STATUS, REASON } from '../match/codes.js';
import { daysBetween } from '../lib/dates.js';

/** Shapes a set of per-invoice decisions into what evaluate() reads. */
function asResult(dataset, decisions, bankStatus) {
  const ledger = dataset.ledger.map((row) => {
    const d = decisions.get(row.invoice_id) ?? { status: STATUS.EXCEPTION, reason: REASON.UNRESOLVED };
    return {
      invoice_id: row.invoice_id, customer: row.customer, date: row.date,
      ledger_amount: row.amount, order_ref: row.order_ref,
      payment_id: d.payment_id ?? null, utr: d.utr ?? null,
      status: d.status, reason: d.reason ?? null, rule: d.rule ?? null,
      confidence: d.confidence ?? 0, detail: d.detail ?? null,
    };
  });
  const bank = dataset.bank.map((b) => ({
    ...b, status: bankStatus.get(b.txn_id) ?? STATUS.EXCEPTION,
    reason: bankStatus.get(b.txn_id) === STATUS.MATCHED ? null : REASON.MISSING_COUNTERPART,
  }));

  const matched = ledger.filter((l) => l.status === STATUS.MATCHED);
  const exceptions = ledger.filter((l) => l.status === STATUS.EXCEPTION);
  const byReason = {};
  for (const e of exceptions) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  const bankExceptions = bank.filter((b) => b.status === STATUS.EXCEPTION);

  return {
    ledger, bank, groups: [], payments: [],
    summary: {
      ledger_rows: ledger.length, matched: matched.length, exceptions: exceptions.length,
      match_rate: ledger.length ? matched.length / ledger.length : 0,
      value_matched_paise: matched.reduce((s, l) => s + l.ledger_amount, 0),
      value_flagged_paise: exceptions.reduce((s, l) => s + l.ledger_amount, 0),
      exceptions_by_reason: byReason,
      settlement_groups: 0, settlements_matched: 0,
      bank_rows: bank.length, bank_exceptions: bankExceptions.length,
      bank_unexplained_credit_paise: bankExceptions.reduce((s, b) => s + b.credit, 0),
    },
  };
}

/**
 * Baseline 1 — the spreadsheet.
 *
 * VLOOKUP the invoice amount against the bank statement, within a week. This is
 * what a finance team does by hand today, and it is the honest floor: Razorpay
 * deducts a fee plus GST and batches a day of payments into one credit, so the
 * invoice amount is almost never a number that appears in the bank at all.
 */
export function spreadsheetBaseline(dataset, { windowDays = 7 } = {}) {
  const decisions = new Map();
  const bankStatus = new Map();
  const claimed = new Set();

  for (const row of dataset.ledger) {
    const hit = dataset.bank.find((b) =>
      !claimed.has(b.txn_id) &&
      b.credit === row.amount &&
      Math.abs(daysBetween(row.date, b.date)) <= windowDays);

    if (hit) {
      claimed.add(hit.txn_id);
      bankStatus.set(hit.txn_id, STATUS.MATCHED);
      decisions.set(row.invoice_id, {
        status: STATUS.MATCHED, rule: 'naive_amount_vlookup', confidence: 1, utr: hit.utr,
      });
    } else {
      decisions.set(row.invoice_id, { status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART });
    }
  }
  return asResult(dataset, decisions, bankStatus);
}

/**
 * Baseline 2 — one leg, nearest candidate.
 *
 * Match the invoice to a Razorpay payment on amount and date, take the closest
 * one when several fit, and call it reconciled. No batch verification, no
 * ambiguity refusal, no check that the money ever reached the bank.
 *
 * This is the interesting one. It is a reasonable-looking build, it scores a
 * HIGHER match rate than the real engine, and it is wrong in the two ways that
 * cost real money: it picks one of several indistinguishable payments instead of
 * escalating, and it books an invoice as reconciled when the payout that was
 * supposed to carry it never arrived in the bank.
 */
export function singleLegBaseline(dataset, { windowDays = 3, tolerancePaise = 200 } = {}) {
  const decisions = new Map();
  const claimed = new Set();

  for (const row of dataset.ledger) {
    const candidates = dataset.payments.filter((p) =>
      !claimed.has(p.id) &&
      Math.abs(p.amount - row.amount) <= tolerancePaise &&
      Math.abs(daysBetween(row.date, p.date)) <= windowDays);

    if (!candidates.length) {
      decisions.set(row.invoice_id, { status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART });
      continue;
    }
    // The whole difference: nearest wins instead of ambiguity being escalated.
    candidates.sort((a, b) =>
      Math.abs(daysBetween(row.date, a.date)) - Math.abs(daysBetween(row.date, b.date)) ||
      Math.abs(a.amount - row.amount) - Math.abs(b.amount - row.amount));
    const pick = candidates[0];
    claimed.add(pick.id);
    decisions.set(row.invoice_id, {
      status: STATUS.MATCHED, rule: 'naive_nearest_payment', confidence: 1,
      payment_id: pick.id, utr: pick.utr,
      detail: { candidates_considered: candidates.length },
    });
  }

  // It never opens the bank statement, so no bank row is ever accounted for.
  return asResult(dataset, decisions, new Map());
}

export const BASELINES = {
  spreadsheet: { label: 'Spreadsheet VLOOKUP (what finance does today)', run: spreadsheetBaseline },
  single_leg: { label: 'One leg, nearest candidate (the obvious build)', run: singleLegBaseline },
};
