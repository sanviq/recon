// The matching engine.
//
// Deterministic and rule-based on purpose. No model decides where money went —
// an LLM that is 97% right about a settlement is 3% wrong about a bank balance,
// and there is no way to audit which 3%. Every decision here is reproducible
// from the inputs and the config, and every decision is written to the audit log
// with the rule that produced it. The language model is used later, and only to
// explain the exceptions this engine has already decided it cannot resolve.
//
// Two legs, because the merchant's real question is not "does this row match a
// row" but "is the money for this invoice actually in my bank account":
//
//   Leg A   ledger invoice  <->  Razorpay payment      (did we capture it?)
//   Leg B   settlement UTR  <->  bank credit           (did they pay us out?)
//
// An invoice is only reconciled when both legs hold. Leg B is inherently
// many-to-one: Razorpay batches a day of payments into one payout under one UTR,
// so a bank statement can never be matched to invoices a row at a time.

import { daysBetween } from '../lib/dates.js';
import { REASON, STATUS, RULE, RULE_CONFIDENCE } from './codes.js';

export const DEFAULT_CONFIG = {
  // Payment capture date minus ledger invoice date. Customers pay a day or two
  // after the invoice; nobody pays before it exists, so the window is asymmetric
  // (one day back only absorbs a late-entered ledger row).
  ledgerDateWindow: { min: -1, max: 3 },

  // Bank value date minus Razorpay settled date. Razorpay's standard cycle is
  // T+2 and the recon report already tells us the settled date, so this window
  // only has to absorb bank-side posting lag and weekends.
  bankCreditWindow: { min: -1, max: 3 },

  // Tolerance exists to absorb rounding — GST on the fee is rounded to the
  // paise, and merchants round by hand in their books. It is deliberately far
  // too small to swallow a real keying error. Floor of Rs 2, then 0.05% of the
  // amount for larger invoices, capped so a big invoice never gets a big blind
  // spot.
  amountTolerance: { floorPaise: 200, bps: 5, capPaise: 10_000 },

  // Batch tolerance is slightly looser because a settlement total is a sum of
  // many rounded nets, so rounding accumulates across the batch.
  batchTolerance: { floorPaise: 500, bps: 5, capPaise: 10_000 },

  // Learn the ledger date window from the rows matched by gateway reference
  // instead of hard-coding one merchant's payment behaviour. See calibrate().
  autoCalibrateWindow: true,
  calibration: { minSamples: 8, percentile: 1.0, maxDays: 14 },
};

export function toleranceFor(amountPaise, t) {
  return Math.min(t.capPaise, Math.max(t.floorPaise, Math.round((Math.abs(amountPaise) * t.bps) / 10_000)));
}

const inWindow = (days, w) => days >= w.min && days <= w.max;

/**
 * @param {object} dataset  output of loadDataset()
 * @param {object} [config] threshold overrides
 * @returns reconciliation result plus the append-only audit trail
 */
export function reconcile(dataset, config = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    ledgerDateWindow: { ...DEFAULT_CONFIG.ledgerDateWindow, ...config.ledgerDateWindow },
    bankCreditWindow: { ...DEFAULT_CONFIG.bankCreditWindow, ...config.bankCreditWindow },
    amountTolerance: { ...DEFAULT_CONFIG.amountTolerance, ...config.amountTolerance },
    batchTolerance: { ...DEFAULT_CONFIG.batchTolerance, ...config.batchTolerance },
    calibration: { ...DEFAULT_CONFIG.calibration, ...config.calibration },
  };

  const audit = [];
  const startedAt = new Date().toISOString();
  const log = (entry) => { audit.push({ seq: audit.length + 1, at: new Date().toISOString(), ...entry }); return entry; };

  const legA = matchLedgerToPayments(dataset, cfg, log);
  const legB = matchSettlementsToBank(dataset, cfg, log);
  const combined = combineLegs(dataset, legA, legB, log);

  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    dataset: { dir: dataset.dir, manifest: dataset.manifest },
    config: cfg,
    calibrated_ledger_window: legA.window,
    ledger: combined.ledger,
    payments: combined.payments,
    bank: legB.bank,
    groups: legB.groups,
    summary: summarise(combined, legB),
    audit,
  };
}

// ---------------------------------------------------------------------------
// Leg A: ledger invoice <-> Razorpay payment
//
// Run as three global passes rather than deciding each row in isolation. Order
// matters: every reference match is settled before any amount-based guess is
// allowed, so a strong match can never lose its payment to a weaker one that
// happened to be evaluated first. Each payment can be claimed exactly once.
// ---------------------------------------------------------------------------
export function matchLedgerToPayments(dataset, cfg, log) {
  const { ledger, payments } = dataset;
  const claimed = new Set();
  const decisions = new Map();

  const byOrderId = new Map();
  for (const p of payments) if (p.order_id) byOrderId.set(p.order_id, p);

  const tol = (amt) => toleranceFor(amt, cfg.amountTolerance);
  const decide = (row, d) => {
    decisions.set(row.invoice_id, d);
    if (d.payment_id) claimed.add(d.payment_id);
    log({
      leg: 'A', subject: 'ledger', subject_id: row.invoice_id,
      decision: d.status, rule: d.rule ?? null, reason: d.reason ?? null,
      confidence: d.confidence, counterpart: d.payment_id ?? null,
      detail: d.detail,
    });
  };

  // --- A1: gateway reference. The only join key that is an identity claim
  // rather than an inference, so it wins outright — including when the amounts
  // disagree. A wrong amount on a row we can positively identify is an amount
  // mismatch to investigate, not an unmatched row. Collapsing those two into
  // "unmatched" is how real recon reports become useless.
  for (const row of ledger) {
    if (!row.order_ref) continue;
    const p = byOrderId.get(row.order_ref);
    if (!p || claimed.has(p.id)) continue;
    const delta = row.amount - p.amount;
    const within = Math.abs(delta) <= tol(p.amount);
    // The date gap is recorded even on a mismatch: the reference already proved
    // these two records are the same transaction, so the gap is a valid
    // observation of payment lag regardless of what the amounts say.
    const gap = daysBetween(row.date, p.date);
    decide(row, within
      ? { status: STATUS.MATCHED, rule: RULE.EXACT_REF, confidence: RULE_CONFIDENCE[RULE.EXACT_REF],
          payment_id: p.id, delta,
          detail: { matched_on: 'order_ref', order_ref: row.order_ref, date_gap_days: gap } }
      : { status: STATUS.EXCEPTION, reason: REASON.AMOUNT_MISMATCH, rule: RULE.EXACT_REF,
          confidence: RULE_CONFIDENCE[RULE.EXACT_REF], payment_id: p.id, delta,
          detail: { matched_on: 'order_ref', order_ref: row.order_ref, date_gap_days: gap,
                    ledger_amount: row.amount, payment_amount: p.amount,
                    tolerance: tol(p.amount) } });
  }

  // --- Calibrate the date window from the rows we just matched with certainty.
  //
  // Every A1 match is a pair we know is correct, and each one hands us a free
  // observation of how long this merchant's customers actually take to pay. So
  // the window used for the uncertain rows is measured from this merchant's own
  // data rather than assumed.
  //
  // It also turned out to protect precision, which is the opposite of the
  // intuition that a tighter window is safer. A window too narrow to contain the
  // true payment does not decline to match — it leaves some coincidental payment
  // as the only candidate in range and matches that instead. Widening the window
  // brings the real payment back in, the row becomes ambiguous, and an ambiguous
  // row is reported rather than guessed. Narrowness was hiding the ambiguity
  // that would have caught the error. (Measured: on the hard profile, widening
  // from 3 to 6 days took recall 85.5% -> 100% and precision 99.9% -> 100%.)
  const window = calibrate(ledger, decisions, cfg, log);

  // --- A2 and A3: no usable reference. Fall back to amount and date.
  // A2 requires the amount to be exactly equal; A3 allows rounding tolerance.
  // Both refuse to choose when more than one payment fits — an ambiguous row is
  // reported as ambiguous, never resolved by picking the nearest. Guessing here
  // is what produces a confident, wrong reconciliation.
  const remaining = () => ledger.filter((r) => !decisions.has(r.invoice_id));

  const amountDatePass = (rule, matches) => {
    for (const row of remaining()) {
      const candidates = payments.filter(
        (p) => !claimed.has(p.id)
          && inWindow(daysBetween(row.date, p.date), window)
          && matches(row, p),
      );
      if (candidates.length === 1) {
        const p = candidates[0];
        decide(row, {
          status: STATUS.MATCHED, rule, confidence: RULE_CONFIDENCE[rule],
          payment_id: p.id, delta: row.amount - p.amount,
          detail: { matched_on: rule === RULE.EXACT_AMOUNT_DATE ? 'amount+date' : 'amount~date',
                    date_gap_days: daysBetween(row.date, p.date) },
        });
      } else if (candidates.length > 1) {
        decide(row, {
          status: STATUS.EXCEPTION, reason: REASON.AMBIGUOUS_CANDIDATES, rule: null,
          confidence: 0, payment_id: null, delta: null,
          detail: { candidate_count: candidates.length,
                    candidate_ids: candidates.slice(0, 5).map((c) => c.id),
                    tried: rule },
        });
      }
    }
  };

  amountDatePass(RULE.EXACT_AMOUNT_DATE, (row, p) => row.amount === p.amount);
  amountDatePass(RULE.FUZZY_AMOUNT_DATE, (row, p) => Math.abs(row.amount - p.amount) <= tol(p.amount));

  // --- Whatever is left has no counterpart in the gateway at all: an invoice
  // settled in cash, a duplicate book entry, or money that never arrived.
  for (const row of remaining()) {
    decide(row, {
      status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART, rule: null,
      confidence: 0, payment_id: null, delta: null,
      detail: { searched: 'order_ref, exact amount+date, tolerant amount+date',
                date_window: window, ledger_amount: row.amount },
    });
  }

  // --- The mirror image: captured payments no ledger row ever claimed. Real
  // revenue with no invoice behind it, which is a bookkeeping hole rather than a
  // missing payment, so it is reported on the payment side.
  const unclaimed = payments.filter((p) => !claimed.has(p.id));
  for (const p of unclaimed) {
    log({
      leg: 'A', subject: 'payment', subject_id: p.id,
      decision: STATUS.EXCEPTION, rule: null, reason: REASON.MISSING_COUNTERPART,
      confidence: 0, counterpart: null,
      detail: { note: 'captured payment with no ledger entry', amount: p.amount, date: p.date },
    });
  }

  return { decisions, claimed, unclaimed, window };
}

/**
 * Derives the ledger date window from the A1 reference matches — pairs we know
 * are correct — so the window reflects this merchant's actual payment lag.
 *
 * Falls back to the configured default when there are too few reference matches
 * to say anything: a window fitted to three data points is not a measurement,
 * and silently trusting it would be worse than using a sensible constant.
 */
export function calibrate(ledger, decisions, cfg, log) {
  const fallback = cfg.ledgerDateWindow;
  if (!cfg.autoCalibrateWindow) return fallback;

  const gaps = [];
  for (const row of ledger) {
    const d = decisions.get(row.invoice_id);
    if (d?.rule === RULE.EXACT_REF && typeof d.detail?.date_gap_days === 'number') {
      gaps.push(d.detail.date_gap_days);
    }
  }

  if (gaps.length < cfg.calibration.minSamples) {
    log({
      leg: 'A', subject: 'calibration', subject_id: 'ledger_date_window',
      decision: 'default', rule: null, reason: null, confidence: null, counterpart: null,
      detail: { note: 'too few reference matches to calibrate', samples: gaps.length,
                required: cfg.calibration.minSamples, window: fallback },
    });
    return fallback;
  }

  gaps.sort((a, b) => a - b);
  const at = (q) => gaps[Math.min(gaps.length - 1, Math.floor(q * (gaps.length - 1)))];

  // Defaults to the observed maximum (percentile 1.0) rather than a trimmed
  // percentile. These gaps come from pairs the gateway reference already proved
  // correct, so the largest one is a lag that genuinely happened to this
  // merchant, not an estimate to be smoothed away. maxDays stops a single
  // garbage date from opening the window indefinitely, and precision is
  // protected by the ambiguity guard rather than by keeping the window narrow.
  // Measured over 40 unseen hard-profile seeds: p95 gave 90.9% recall with one
  // misroute, the observed max gave 95.4% recall with none.
  //
  // The window is only ever widened past the configured default, never
  // tightened below it — the default is a floor on coverage, not a target.
  const window = {
    min: Math.min(fallback.min, at(1 - cfg.calibration.percentile)),
    max: Math.min(cfg.calibration.maxDays, Math.max(fallback.max, at(cfg.calibration.percentile))),
  };

  log({
    leg: 'A', subject: 'calibration', subject_id: 'ledger_date_window',
    decision: 'calibrated', rule: null, reason: null, confidence: null, counterpart: null,
    detail: { samples: gaps.length, p50: at(0.5), p95: at(0.95), observed_max: gaps[gaps.length - 1],
              configured: fallback, window },
  });
  return window;
}

// ---------------------------------------------------------------------------
// Leg B: settlement UTR <-> bank credit
//
// This is the batch match. Payments are grouped by the UTR the recon report says
// paid them out, the group's expected credit is the sum of the recomputed nets,
// and that single number is matched against the bank. Many invoices, one credit.
// ---------------------------------------------------------------------------
export function matchSettlementsToBank(dataset, cfg, log) {
  const { payments, bank } = dataset;

  const groups = new Map();
  for (const p of payments) {
    if (!p.utr) continue;
    if (!groups.has(p.utr)) {
      groups.set(p.utr, {
        utr: p.utr, settlement_id: p.settlement_id, settled_date: p.settled_date,
        payment_ids: [], expected_credit: 0, gross: 0, fees: 0, tax: 0,
      });
    }
    const g = groups.get(p.utr);
    g.payment_ids.push(p.id);
    g.expected_credit += p.net;
    g.gross += p.amount;
    g.fees += p.fee;
    g.tax += p.tax;
  }

  const bankByUTR = new Map();
  for (const b of bank) {
    if (!b.utr) continue;
    if (!bankByUTR.has(b.utr)) bankByUTR.set(b.utr, []);
    bankByUTR.get(b.utr).push(b);
  }

  const bankStatus = new Map();
  const setBank = (b, d) => {
    bankStatus.set(b.txn_id, d);
    log({
      leg: 'B', subject: 'bank', subject_id: b.txn_id,
      decision: d.status, rule: d.rule ?? null, reason: d.reason ?? null,
      confidence: d.confidence, counterpart: d.utr ?? null, detail: d.detail,
    });
  };

  const out = [];
  for (const g of groups.values()) {
    const rows = bankByUTR.get(g.utr) ?? [];
    const tol = toleranceFor(g.expected_credit, cfg.batchTolerance);
    let d;

    if (rows.length === 0) {
      // Razorpay says it paid out; the bank has no record of it. Either the
      // payout is still in flight or it genuinely never landed — both are the
      // merchant's money missing, so it is never auto-cleared.
      d = { status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART, rule: null, confidence: 0,
            detail: { expected_credit: g.expected_credit, note: 'settlement has no matching bank credit' } };
    } else if (rows.length > 1) {
      // More than one credit under one UTR is ambiguous on its face, and the sum
      // is what disambiguates it. Tranches that add up to the payout are a split
      // settlement — normal Razorpay behaviour, and treating it as a duplicate
      // would flag a perfectly good batch. A sum that overshoots is a genuine
      // double-post: the cash position is overstated, no rule can safely pick
      // which row is real, and a human has to decide.
      const total = rows.reduce((s, r) => s + r.credit, 0);
      const latest = rows.reduce((a, b) => (a.date > b.date ? a : b));
      const gap = g.settled_date ? daysBetween(g.settled_date, latest.date) : 0;

      if (Math.abs(total - g.expected_credit) <= tol && inWindow(gap, cfg.bankCreditWindow)) {
        d = { status: STATUS.MATCHED, reason: null, rule: RULE.BATCH_SPLIT,
              confidence: RULE_CONFIDENCE[RULE.BATCH_SPLIT],
              detail: { expected_credit: g.expected_credit, credited: total,
                        delta: total - g.expected_credit, tranches: rows.length,
                        txn_ids: rows.map((r) => r.txn_id), credits: rows.map((r) => r.credit),
                        gap_days: gap, invoices_in_batch: g.payment_ids.length } };
      } else {
        d = { status: STATUS.EXCEPTION, reason: REASON.DUPLICATE_UTR, rule: null, confidence: 0,
              detail: { count: rows.length, txn_ids: rows.map((r) => r.txn_id),
                        credits: rows.map((r) => r.credit), total_credited: total,
                        expected_credit: g.expected_credit, overstated_by: total - g.expected_credit } };
      }
    } else {
      const b = rows[0];
      const gap = g.settled_date ? daysBetween(g.settled_date, b.date) : 0;
      const delta = b.credit - g.expected_credit;
      if (!inWindow(gap, cfg.bankCreditWindow)) {
        // Checked before the amount, deliberately. A credit that arrives nine
        // days late may still be the right amount, and reporting it as an amount
        // match would hide the fact that the cash was not where the books said.
        d = { status: STATUS.EXCEPTION, reason: REASON.DATE_OUT_OF_WINDOW, rule: null, confidence: 0,
              detail: { settled_date: g.settled_date, credited_date: b.date, gap_days: gap,
                        window: cfg.bankCreditWindow, txn_id: b.txn_id, delta } };
      } else if (Math.abs(delta) > tol) {
        d = { status: STATUS.EXCEPTION, reason: REASON.AMOUNT_MISMATCH, rule: null, confidence: 0,
              detail: { expected_credit: g.expected_credit, credited: b.credit, delta,
                        tolerance: tol, txn_id: b.txn_id } };
      } else {
        const rule = delta === 0 ? RULE.BATCH_EXACT : RULE.BATCH_TOLERANCE;
        d = { status: STATUS.MATCHED, reason: null, rule, confidence: RULE_CONFIDENCE[rule],
              detail: { expected_credit: g.expected_credit, credited: b.credit, delta,
                        gap_days: gap, txn_id: b.txn_id, invoices_in_batch: g.payment_ids.length } };
      }
      setBank(b, { ...d, utr: g.utr });
    }

    if (rows.length !== 1) for (const b of rows) setBank(b, { ...d, utr: g.utr });

    log({
      leg: 'B', subject: 'settlement', subject_id: g.utr,
      decision: d.status, rule: d.rule ?? null, reason: d.reason ?? null,
      confidence: d.confidence, counterpart: rows.map((r) => r.txn_id).join(',') || null,
      detail: d.detail,
    });
    out.push({ ...g, status: d.status, reason: d.reason ?? null, rule: d.rule ?? null,
               confidence: d.confidence, bank_txn_ids: rows.map((r) => r.txn_id),
               credited: rows.length ? rows.reduce((s, r) => s + r.credit, 0) : null,
               detail: d.detail });
  }

  // Credits with a UTR that Razorpay never issued: another payment provider, a
  // direct customer transfer, a loan disbursal. Unexplained money is still an
  // exception — a reconciliation that only looks for what it expects will
  // happily miss cash it cannot account for.
  for (const b of bank) {
    if (bankStatus.has(b.txn_id)) continue;
    setBank(b, {
      status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART, rule: null, confidence: 0,
      utr: b.utr || null,
      detail: { note: 'bank credit with no matching Razorpay settlement',
                credit: b.credit, utr: b.utr, description: b.description },
    });
  }

  return {
    groups: out,
    byUTR: new Map(out.map((g) => [g.utr, g])),
    bank: bank.map((b) => ({ ...b, ...(bankStatus.get(b.txn_id) ?? {}) })),
  };
}

// ---------------------------------------------------------------------------
// An invoice is reconciled only if both legs hold. If leg A failed we do not
// know which settlement to look at, so leg A's reason wins; otherwise the
// invoice inherits its batch's problem, because that is the reason its money is
// not confirmed. Confidence is the weaker of the two legs, never the average —
// a chain is not more trustworthy than its weakest link.
// ---------------------------------------------------------------------------
function combineLegs(dataset, legA, legB, log) {
  const paymentById = new Map(dataset.payments.map((p) => [p.id, p]));

  const ledger = dataset.ledger.map((row) => {
    const a = legA.decisions.get(row.invoice_id);
    const payment = a.payment_id ? paymentById.get(a.payment_id) : null;
    const group = payment?.utr ? legB.byUTR.get(payment.utr) : null;

    const base = {
      invoice_id: row.invoice_id, customer: row.customer, date: row.date,
      ledger_amount: row.amount, order_ref: row.order_ref,
      payment_id: a.payment_id ?? null, utr: payment?.utr ?? null,
      payment_amount: payment?.amount ?? null, fee: payment?.fee ?? null,
      tax: payment?.tax ?? null, net: payment?.net ?? null,
      settled_date: payment?.settled_date ?? null,
      delta: a.delta ?? null, leg_a: { status: a.status, rule: a.rule ?? null, reason: a.reason ?? null },
      leg_b: group ? { status: group.status, rule: group.rule, reason: group.reason } : null,
      detail: a.detail,
    };

    if (a.status === STATUS.EXCEPTION) {
      return { ...base, status: STATUS.EXCEPTION, reason: a.reason, rule: a.rule ?? null, confidence: a.confidence };
    }
    if (!group) {
      return { ...base, status: STATUS.EXCEPTION, reason: REASON.MISSING_COUNTERPART, rule: null, confidence: 0,
               detail: { ...a.detail, note: 'payment matched but not yet settled to a UTR' } };
    }
    if (group.status === STATUS.EXCEPTION) {
      return { ...base, status: STATUS.EXCEPTION, reason: group.reason, rule: a.rule, confidence: 0,
               detail: { ...a.detail, batch: group.detail } };
    }
    const confidence = Math.min(a.confidence, group.confidence);
    log({
      leg: 'AB', subject: 'invoice', subject_id: row.invoice_id,
      decision: STATUS.MATCHED, rule: `${a.rule}+${group.rule}`, reason: null,
      confidence, counterpart: `${a.payment_id}/${payment.utr}`,
      detail: { net: payment.net, utr: payment.utr },
    });
    return { ...base, status: STATUS.MATCHED, reason: null, rule: `${a.rule}+${group.rule}`, confidence };
  });

  const payments = dataset.payments.map((p) => {
    const claimedBy = ledger.find((l) => l.payment_id === p.id);
    const group = p.utr ? legB.byUTR.get(p.utr) : null;
    const status = claimedBy && claimedBy.status === STATUS.MATCHED ? STATUS.MATCHED : STATUS.EXCEPTION;
    return {
      ...p, raw: undefined,
      status,
      reason: status === STATUS.MATCHED ? null
        : !claimedBy ? REASON.MISSING_COUNTERPART
        : claimedBy.reason,
      invoice_id: claimedBy?.invoice_id ?? null,
      batch_status: group?.status ?? null,
    };
  });

  return { ledger, payments };
}

function summarise(combined, legB) {
  const { ledger } = combined;
  const matched = ledger.filter((l) => l.status === STATUS.MATCHED);
  const exceptions = ledger.filter((l) => l.status === STATUS.EXCEPTION);
  const byReason = {};
  for (const e of exceptions) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;

  const bankExceptions = legB.bank.filter((b) => b.status === STATUS.EXCEPTION);

  return {
    ledger_rows: ledger.length,
    matched: matched.length,
    exceptions: exceptions.length,
    match_rate: ledger.length ? matched.length / ledger.length : 0,
    // Value, not just row counts. A 95% match rate that leaves the single
    // largest invoice unmatched is not a good day, and a row-count-only report
    // hides that.
    value_matched_paise: matched.reduce((s, l) => s + l.ledger_amount, 0),
    value_flagged_paise: exceptions.reduce((s, l) => s + l.ledger_amount, 0),
    exceptions_by_reason: byReason,
    settlement_groups: legB.groups.length,
    settlements_matched: legB.groups.filter((g) => g.status === STATUS.MATCHED).length,
    bank_rows: legB.bank.length,
    bank_exceptions: bankExceptions.length,
    bank_unexplained_credit_paise: bankExceptions.reduce((s, b) => s + b.credit, 0),
  };
}
