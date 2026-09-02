// Builds a bank statement from a settlement schedule.
//
// Shared by the fully synthetic generator and the live Razorpay pull, so the
// bank leg behaves identically whichever spine the payments came from. Only the
// bank statement is ever fabricated in the live path — the payments and the
// settlement UTRs come from the gateway.

import { addDays } from '../lib/dates.js';
import { RUPEE } from '../lib/money.js';
import { REASON } from '../match/codes.js';

/**
 * @returns {{ bank: object[], settlementFaults: Map<string,string>, settlementReason: Map<string,string> }}
 */
export function buildBankStatement(settlements, { rng, faults, openingBalancePaise = 4_25_000 * RUPEE }) {
  const settlementFaults = new Map();
  const pick = (n, predicate = () => true) =>
    rng.shuffle(settlements.filter((s) => !settlementFaults.has(s.id) && predicate(s))).slice(0, n);

  // Keep the disruptive faults on small batches: one injected fault should not
  // taint a third of the dataset and distort the headline match rate.
  const isSmall = (s) => (s.payment_ids?.length ?? 1) <= 4;
  for (const s of pick(faults.lateSettlements, isSmall)) settlementFaults.set(s.id, 'late');
  for (const s of pick(faults.duplicateCredits, isSmall)) settlementFaults.set(s.id, 'duplicate');
  for (const s of pick(faults.shortCredits)) settlementFaults.set(s.id, 'short');
  // A split payout is not a fault — Razorpay really does pay one settlement out
  // in parts. It is here because a matcher that assumes one UTR means one credit
  // will call it a duplicate and flag a perfectly good batch.
  for (const s of pick(faults.splitCredits, isSmall)) settlementFaults.set(s.id, 'split');

  const bank = [];
  let balance = openingBalancePaise;
  let seq = 0;
  const nextTxnId = (d) => `TXN${d.replace(/-/g, '')}${String(++seq).padStart(4, '0')}`;
  const push = (row) => { balance += row.credit; bank.push({ ...row, balance }); return bank[bank.length - 1]; };

  for (const s of settlements) {
    const fault = settlementFaults.get(s.id);
    // A late credit is late in the bank, not in the gateway: Razorpay says it
    // paid on T+2, the money shows up nine days later.
    const creditDate = fault === 'late' ? addDays(s.settled_date, rng.int(6, 9)) : s.settled_date;
    // A short credit models a bank-side deduction the gateway never reported.
    const credit = s.amount - (fault === 'short' ? rng.int(150, 900) * RUPEE : 0);
    const narration = `NEFT CR RAZORPAY SOFTWARE PVT LTD ${s.utr}`;

    if (fault === 'split') {
      const first = Math.round(credit * 0.6);
      push({ txn_id: nextTxnId(creditDate), value_date: creditDate, description: narration,
             utr: s.utr, credit: first, debit: 0, _settlement_id: s.id, _fault: 'split' });
      const restDate = addDays(creditDate, 1);
      push({ txn_id: nextTxnId(restDate), value_date: restDate, description: narration,
             utr: s.utr, credit: credit - first, debit: 0, _settlement_id: s.id, _fault: 'split' });
      continue;
    }

    push({ txn_id: nextTxnId(creditDate), value_date: creditDate, description: narration,
           utr: s.utr, credit, debit: 0, _settlement_id: s.id, _fault: fault ?? null });

    if (fault === 'duplicate') {
      // Same UTR posted twice. The cash position is now overstated by one whole
      // settlement, and no rule can safely decide which row is the real one.
      push({ txn_id: nextTxnId(creditDate), value_date: creditDate, description: narration,
             utr: s.utr, credit, debit: 0, _settlement_id: s.id, _fault: 'duplicate' });
    }
  }

  // Credits Razorpay never sent — another PSP, a manual transfer, a customer
  // paying by direct bank transfer. Unexplained money is still an exception.
  const dates = settlements.map((s) => s.settled_date).sort();
  const first = dates[0] ?? '2026-08-05';
  const span = Math.max(1, dates.length ? daysSpan(first, dates[dates.length - 1]) : 20);
  for (let i = 0; i < faults.orphanCredits; i++) {
    const date = addDays(first, rng.int(0, span));
    push({
      txn_id: nextTxnId(date), value_date: date, description: 'IMPS CR CUSTOMER TRANSFER',
      utr: `IMPS${date.replace(/-/g, '').slice(2)}${String(rng.int(1, 9999)).padStart(4, '0')}`,
      credit: rng.int(2_000, 60_000) * RUPEE, debit: 0, _settlement_id: null, _fault: 'orphan',
    });
  }

  bank.sort((a, b) => a.value_date.localeCompare(b.value_date) || a.txn_id.localeCompare(b.txn_id));

  // A split payout is deliberately absent from this map: it is normal gateway
  // behaviour, so the correct answer for a split batch is "matched".
  const settlementReason = new Map();
  for (const [sid, fault] of settlementFaults) {
    if (fault === 'split') continue;
    settlementReason.set(sid,
      fault === 'late' ? REASON.DATE_OUT_OF_WINDOW
        : fault === 'duplicate' ? REASON.DUPLICATE_UTR
        : REASON.AMOUNT_MISMATCH);
  }

  return { bank, settlementFaults, settlementReason };
}

/** Bank truth rows, derived from how the statement was built. */
export function bankTruth(bank, settlementReason) {
  return bank.map((b) => {
    if (b._fault === 'orphan') {
      return { txn_id: b.txn_id, status: 'exception', reason: REASON.MISSING_COUNTERPART,
               settlement_id: null, fault: 'orphan_credit' };
    }
    const reason = settlementReason.get(b._settlement_id);
    return reason
      ? { txn_id: b.txn_id, status: 'exception', reason, settlement_id: b._settlement_id, fault: `settlement_${b._fault}` }
      : { txn_id: b.txn_id, status: 'matched', reason: null, settlement_id: b._settlement_id, fault: null };
  });
}

function daysSpan(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
}
