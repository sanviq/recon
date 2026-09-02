// Razorpay test-mode client.
//
// Pulls the two things only the gateway knows: the payments it captured, and
// which payout UTR each one was settled under. Everything else in Recon is the
// merchant's own data.
//
// One thing worth being upfront about: Razorpay test mode does not run a real
// settlement cycle, so settlements.reports() is usually empty even when there
// are plenty of test payments. When that happens we derive the settlement
// schedule locally from Razorpay's actual T+2 rules and mark the dataset
// derived: true, rather than quietly presenting a synthetic UTR as one the
// gateway issued.

import Razorpay from 'razorpay';
import { unixToISODate, addDays, isoToUnix } from '../lib/dates.js';

export function makeClient({ keyId, keySecret } = {}) {
  const key_id = keyId ?? process.env.RAZORPAY_KEY_ID;
  const key_secret = keySecret ?? process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set — copy .env.example to .env');
  }
  if (!key_id.startsWith('rzp_test_')) {
    // A live key here would pull real customer payment data into a hackathon
    // repo. Refusing is the only safe default.
    throw new Error(`refusing to run against a non-test key (${key_id.slice(0, 12)}...) — Recon is test-mode only`);
  }
  return new Razorpay({ key_id, key_secret });
}

/** Pages through a Razorpay collection endpoint until it stops returning items. */
async function fetchAll(fetchPage, { pageSize = 100, maxPages = 50 } = {}) {
  const items = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage({ count: pageSize, skip: page * pageSize });
    const batch = res?.items ?? [];
    items.push(...batch);
    if (batch.length < pageSize) break;
  }
  return items;
}

export async function fetchPayments(client, { from, to }) {
  const all = await fetchAll(({ count, skip }) =>
    client.payments.all({ from: isoToUnix(from), to: isoToUnix(to) + 86_399, count, skip }));

  // Only captured payments represent money that will actually be settled.
  // Authorized-but-uncaptured and failed payments have no bank leg to match.
  return all
    .filter((p) => p.status === 'captured')
    .map((p) => ({
      id: p.id,
      entity: 'payment',
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      order_id: p.order_id ?? null,
      method: p.method,
      captured: p.captured,
      description: p.description ?? '',
      fee: p.fee ?? 0,
      tax: p.tax ?? 0,
      net: p.amount - (p.fee ?? 0) - (p.tax ?? 0),
      created_at: p.created_at,
      captured_date: unixToISODate(p.created_at),
      notes: p.notes ?? {},
    }));
}

export async function fetchSettlements(client, { from, to }) {
  const items = await fetchAll(({ count, skip }) =>
    client.settlements.all({ from: isoToUnix(from), to: isoToUnix(to) + 86_399, count, skip }));
  return items.map((s) => ({
    id: s.id,
    entity: 'settlement',
    amount: s.amount,
    status: s.status,
    fees: s.fees ?? 0,
    tax: s.tax ?? 0,
    utr: s.utr,
    created_at: s.created_at,
    settled_date: unixToISODate(s.created_at),
    payment_ids: [],
  }));
}

/**
 * The settlement recon report is the only endpoint that says which payment was
 * paid out under which UTR — a payment does not know its own settlement, so
 * without this the bank leg has no join key at all.
 *
 * It is queried one day at a time because that is the granularity the API takes.
 */
export async function fetchReconReport(client, { from, to }) {
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const [year, month, day] = d.split('-').map(Number);
    try {
      const page = await fetchAll(({ count, skip }) =>
        client.settlements.reports({ year, month, day, count, skip }));
      rows.push(...page);
    } catch (err) {
      // A day with no settlement is a 400 from this endpoint, not an empty list.
      // Treating that as fatal would make any gap in the month fail the pull.
      if (!isNoSettlementError(err)) throw err;
    }
  }
  return rows;
}

function isNoSettlementError(err) {
  const status = err?.statusCode ?? err?.status;
  const description = err?.error?.description ?? err?.message ?? '';
  return status === 400 || /no settlement|not found/i.test(description);
}

/**
 * Reconstructs the settlement schedule when test mode has not produced one.
 *
 * Applies Razorpay's real rule — payments captured on day D are paid out on
 * D+lag as a single batch — so the shape of the data (many payments, one UTR,
 * net of fees and GST) matches production even though the UTRs are ours.
 * Anything built this way is flagged derived: true everywhere it surfaces.
 */
export function deriveSettlements(payments, { settlementLagDays = 2 } = {}) {
  const byPayoutDate = new Map();
  for (const p of payments) {
    const payoutDate = addDays(p.captured_date, settlementLagDays);
    if (!byPayoutDate.has(payoutDate)) byPayoutDate.set(payoutDate, []);
    byPayoutDate.get(payoutDate).push(p);
  }

  return [...byPayoutDate.keys()].sort().map((payoutDate, i) => {
    const members = byPayoutDate.get(payoutDate);
    return {
      id: `setl_derived_${payoutDate.replace(/-/g, '')}`,
      entity: 'settlement',
      amount: members.reduce((s, p) => s + p.net, 0),
      status: 'processed',
      fees: members.reduce((s, p) => s + p.fee, 0),
      tax: members.reduce((s, p) => s + p.tax, 0),
      // Deliberately not disguised as a bank UTR. Anyone reading the data can
      // see at a glance that this identifier did not come from Razorpay.
      utr: `DERIVED${payoutDate.replace(/-/g, '').slice(2)}${String(i + 1).padStart(4, '0')}`,
      created_at: isoToUnix(payoutDate) + 11 * 3600,
      settled_date: payoutDate,
      payment_ids: members.map((p) => p.id),
      derived: true,
    };
  });
}

/** Builds recon-report rows from settlements, in the same shape the API returns. */
export function reconRowsFrom(payments, settlements) {
  const settlementByPayment = new Map();
  for (const s of settlements) {
    for (const pid of s.payment_ids) settlementByPayment.set(pid, s);
  }
  return payments
    .filter((p) => settlementByPayment.has(p.id))
    .map((p) => {
      const s = settlementByPayment.get(p.id);
      return {
        entity_id: p.id, type: 'payment', debit: 0, credit: p.net,
        amount: p.amount, currency: p.currency, fee: p.fee, tax: p.tax,
        on_hold: false, settled: true,
        created_at: p.created_at, settled_at: s.created_at,
        settlement_id: s.id, settlement_utr: s.utr,
        order_id: p.order_id, payment_id: p.id,
        description: p.description, notes: p.notes,
        derived: s.derived ?? false,
      };
    });
}

/**
 * Attaches payment ids to settlements using the recon report, which is the only
 * place the association is recorded.
 */
export function linkSettlements(settlements, reconRows) {
  const byId = new Map(settlements.map((s) => [s.id, { ...s, payment_ids: [] }]));
  for (const r of reconRows) {
    const s = byId.get(r.settlement_id);
    if (s) s.payment_ids.push(r.payment_id ?? r.entity_id);
  }
  return [...byId.values()];
}
