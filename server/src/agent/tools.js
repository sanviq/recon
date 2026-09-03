// The tools the controller agent is allowed to use.
//
// Every one of them is a read over a finished reconciliation run. There is no
// tool that matches, clears, re-runs, edits or writes anything, and that is not a
// policy the model is asked to respect — it is the entire surface it has. The
// worst a wrong answer can do here is be wrong out loud, which a human reading it
// can catch, rather than move money, which they cannot.
//
// Amounts go out as formatted rupee strings, never paise integers, for the same
// reason the explainer does it: the model should be reading numbers, not doing
// arithmetic on them. Where a total is genuinely needed, a tool computes it.

import { formatPaise } from '../lib/money.js';
import { REASON, REASON_LABEL, STATUS } from '../match/codes.js';

const rs = (paise) => (typeof paise === 'number' ? formatPaise(paise) : null);
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

export const TOOL_DEFS = [
  {
    name: 'reconciliation_summary',
    description: 'Headline numbers for the whole run: how many invoices matched, how much value was auto-reconciled versus flagged, exception counts by reason code, settlement batch counts, and unexplained bank credit. Start here for any question about the overall state of the month.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_exceptions',
    description: 'Find flagged records — unmatched invoices and unexplained bank credits. Filter by reason code, severity, or minimum amount. Use this for "what is wrong", "what should I chase", "show me the duplicates".',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: Object.values(REASON), description: 'Restrict to one reason code.' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Restrict to one severity, as assigned by the exception note.' },
        kind: { type: 'string', enum: ['invoice', 'bank_credit'], description: 'Restrict to flagged invoices or to unexplained bank credits.' },
        min_amount_rupees: { type: 'number', description: 'Only records at or above this rupee amount.' },
        sort: { type: 'string', enum: ['amount_desc', 'amount_asc', 'severity', 'date'], description: 'Default is severity, then amount.' },
        limit: { type: 'integer', description: 'Maximum rows to return. Default 20, maximum 100.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_invoice',
    description: 'Everything known about one invoice: its ledger values, the Razorpay payment it was linked to (if any), the fee and GST, the settlement batch it belongs to, which leg of the reconciliation failed, and its exception note. Use this whenever the user names an invoice.',
    input_schema: {
      type: 'object',
      properties: { invoice_id: { type: 'string', description: 'The invoice identifier, e.g. INV-2026-0046.' } },
      required: ['invoice_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_settlement_batch',
    description: 'One settlement batch by UTR: which payments Razorpay paid out under it, what the bank was expected to credit, what it actually credited, the gap in days, and every invoice sitting inside the batch. Use this to explain why a whole group of invoices is flagged at once.',
    input_schema: {
      type: 'object',
      properties: { utr: { type: 'string', description: 'The settlement UTR.' } },
      required: ['utr'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_settlement_batches',
    description: 'All settlement batches, optionally filtered to the ones that did not confirm against the bank. Use this for questions about payouts rather than individual invoices.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['matched', 'exception'], description: 'Restrict to confirmed or flagged batches.' },
        limit: { type: 'integer', description: 'Default 25.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'aggregate_exceptions',
    description: 'Count flagged records and total their rupee value, grouped by reason code, severity, or kind. Use this instead of listing rows when the user asks "how much" or "how many".',
    input_schema: {
      type: 'object',
      properties: { group_by: { type: 'string', enum: ['reason', 'severity', 'kind'] } },
      required: ['group_by'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_audit',
    description: 'Read the append-only decision log: which rule fired on which record, with what confidence, and when. Use this when the user asks why a specific decision was made, or wants proof that a decision was recorded.',
    input_schema: {
      type: 'object',
      properties: {
        subject_id: { type: 'string', description: 'An invoice id, UTR or bank transaction id to trace.' },
        leg: { type: 'string', enum: ['A', 'B', 'AB', 'explain', 'ingest'], description: 'A is ledger-to-payment, B is settlement-to-bank, AB is the combined decision.' },
        decision: { type: 'string', enum: ['matched', 'exception', 'explained', 'mapped'] },
        limit: { type: 'integer', description: 'Default 20.' },
      },
      additionalProperties: false,
    },
  },
];

const clamp = (n, def, max) => Math.min(Math.max(Number.isFinite(n) ? n : def, 1), max);

const invoiceRow = (l) => ({
  kind: 'invoice',
  invoice_id: l.invoice_id,
  customer: l.customer || null,
  invoice_date: l.date,
  amount_rupees: rs(l.ledger_amount),
  status: l.status,
  reason: l.reason,
  reason_label: l.reason ? (REASON_LABEL[l.reason] ?? l.reason) : null,
  severity: l.note?.severity ?? null,
  payment_id: l.payment_id,
  utr: l.utr,
  note: l.note?.explanation ?? null,
  suggested_action: l.note?.suggested_action ?? null,
});

const bankRow = (b) => ({
  kind: 'bank_credit',
  bank_transaction_id: b.txn_id,
  value_date: b.date,
  amount_rupees: rs(b.credit),
  utr: b.utr || null,
  narration: b.description,
  status: b.status,
  reason: b.reason,
  severity: b.note?.severity ?? null,
  note: b.note?.explanation ?? null,
  suggested_action: b.note?.suggested_action ?? null,
});

/**
 * Binds the tool implementations to one loaded result. `audit` is optional —
 * without it search_audit says the log is unavailable rather than inventing
 * entries, which is the failure mode that matters here.
 */
export function buildToolbox(result, audit = []) {
  const ledgerById = new Map(result.ledger.map((l) => [String(l.invoice_id).toUpperCase(), l]));
  const groupByUTR = new Map(result.groups.map((g) => [String(g.utr).toUpperCase(), g]));
  const paymentById = new Map((result.payments ?? []).map((p) => [p.id, p]));

  const exceptions = () => [
    ...result.ledger.filter((l) => l.status === STATUS.EXCEPTION).map(invoiceRow),
    ...result.bank.filter((b) => b.status === STATUS.EXCEPTION).map(bankRow),
  ];

  const impl = {
    reconciliation_summary() {
      const s = result.summary;
      return {
        dataset: result.dataset ?? null,
        invoices_total: s.ledger_rows,
        invoices_matched: s.matched,
        invoices_flagged: s.exceptions,
        match_rate: `${(s.match_rate * 100).toFixed(1)}%`,
        value_auto_reconciled_rupees: rs(s.value_matched_paise),
        value_flagged_rupees: rs(s.value_flagged_paise),
        exceptions_by_reason: s.exceptions_by_reason,
        settlement_batches: s.settlement_groups,
        settlement_batches_confirmed: s.settlements_matched,
        bank_rows: s.bank_rows,
        bank_credits_unexplained: s.bank_exceptions,
        unexplained_bank_credit_rupees: rs(s.bank_unexplained_credit_paise),
        settlement_lag_window_days: result.calibrated_ledger_window ?? result.config?.ledgerDateWindow ?? null,
        explanations: result.explanations
          ? { count: result.explanations.count, written_by_model: result.explanations.from_model, written_by_template: result.explanations.from_template }
          : null,
      };
    },

    search_exceptions({ reason, severity, kind, min_amount_rupees, sort = 'severity', limit } = {}) {
      let rows = exceptions();
      if (reason) rows = rows.filter((r) => r.reason === reason);
      if (severity) rows = rows.filter((r) => r.severity === severity);
      if (kind) rows = rows.filter((r) => r.kind === kind);
      if (typeof min_amount_rupees === 'number') {
        rows = rows.filter((r) => Number(String(r.amount_rupees).replace(/,/g, '')) >= min_amount_rupees);
      }
      const amount = (r) => Number(String(r.amount_rupees).replace(/,/g, ''));
      const sorters = {
        amount_desc: (a, b) => amount(b) - amount(a),
        amount_asc: (a, b) => amount(a) - amount(b),
        date: (a, b) => String(a.invoice_date ?? a.value_date).localeCompare(String(b.invoice_date ?? b.value_date)),
        severity: (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || amount(b) - amount(a),
      };
      rows.sort(sorters[sort] ?? sorters.severity);
      const n = clamp(limit, 20, 100);
      return { total_matching: rows.length, returned: Math.min(n, rows.length), rows: rows.slice(0, n) };
    },

    get_invoice({ invoice_id }) {
      const l = ledgerById.get(String(invoice_id).trim().toUpperCase());
      if (!l) {
        return { found: false, invoice_id, note: 'No invoice with that id is in this run. Check the id, or search the exception list instead.' };
      }
      const g = l.utr ? groupByUTR.get(String(l.utr).toUpperCase()) : null;
      const p = l.payment_id ? paymentById.get(l.payment_id) : null;
      return {
        found: true,
        ...invoiceRow(l),
        rule_that_fired: l.rule ?? null,
        confidence: l.confidence,
        failing_leg: l.leg_a?.status === STATUS.EXCEPTION ? 'ledger_to_payment'
          : l.leg_b?.status === STATUS.EXCEPTION ? 'settlement_to_bank' : null,
        razorpay_payment: p || l.payment_id ? {
          payment_id: l.payment_id,
          captured_date: p?.date ?? null,
          captured_amount_rupees: rs(l.payment_amount),
          razorpay_fee_rupees: rs(l.fee),
          gst_on_fee_rupees: rs(l.tax),
          net_paid_out_rupees: rs(l.net),
          ledger_minus_gateway_rupees: rs(l.delta),
        } : null,
        settlement_batch: g ? {
          utr: g.utr, status: g.status, reason: g.reason,
          payments_in_batch: g.payment_ids?.length ?? null,
          expected_credit_rupees: rs(g.expected_credit),
          actually_credited_rupees: rs(g.credited),
          bank_transactions: g.bank_txn_ids ?? [],
        } : null,
      };
    },

    get_settlement_batch({ utr }) {
      const g = groupByUTR.get(String(utr).trim().toUpperCase());
      if (!g) return { found: false, utr, note: 'No settlement batch with that UTR is in this run.' };
      const invoices = result.ledger.filter((l) => l.utr === g.utr);
      return {
        found: true, utr: g.utr, status: g.status, reason: g.reason,
        rule_that_fired: g.rule ?? null, confidence: g.confidence,
        settled_date: g.settled_date ?? null,
        payments_in_batch: g.payment_ids?.length ?? null,
        expected_credit_rupees: rs(g.expected_credit),
        actually_credited_rupees: rs(g.credited),
        shortfall_or_excess_rupees: typeof g.credited === 'number' && typeof g.expected_credit === 'number'
          ? rs(g.credited - g.expected_credit) : null,
        days_between_payout_and_credit: g.detail?.gap_days ?? null,
        bank_transactions: g.bank_txn_ids ?? [],
        invoices_in_batch: invoices.map((l) => ({
          invoice_id: l.invoice_id, amount_rupees: rs(l.ledger_amount), status: l.status, reason: l.reason,
        })),
      };
    },

    list_settlement_batches({ status, limit } = {}) {
      let gs = result.groups;
      if (status) gs = gs.filter((g) => g.status === status);
      const n = clamp(limit, 25, 100);
      return {
        total_matching: gs.length,
        rows: gs.slice(0, n).map((g) => ({
          utr: g.utr, status: g.status, reason: g.reason,
          payments_in_batch: g.payment_ids?.length ?? null,
          expected_credit_rupees: rs(g.expected_credit),
          actually_credited_rupees: rs(g.credited),
          bank_transactions: g.bank_txn_ids ?? [],
        })),
      };
    },

    aggregate_exceptions({ group_by }) {
      const key = { reason: (r) => r.reason ?? 'unknown', severity: (r) => r.severity ?? 'unrated', kind: (r) => r.kind }[group_by];
      const acc = new Map();
      for (const r of exceptions()) {
        const k = key(r);
        const paise = Math.round(Number(String(r.amount_rupees).replace(/,/g, '')) * 100);
        const cur = acc.get(k) ?? { count: 0, paise: 0 };
        acc.set(k, { count: cur.count + 1, paise: cur.paise + paise });
      }
      return {
        group_by,
        groups: [...acc.entries()]
          .sort((a, b) => b[1].paise - a[1].paise)
          .map(([k, v]) => ({ [group_by]: k, count: v.count, total_rupees: rs(v.paise) })),
      };
    },

    search_audit({ subject_id, leg, decision, limit } = {}) {
      if (!audit.length) return { available: false, note: 'The audit log for this run is not available to read.' };
      let rows = audit;
      if (subject_id) {
        const q = String(subject_id).toUpperCase();
        rows = rows.filter((e) => String(e.subject_id ?? '').toUpperCase() === q || String(e.counterpart ?? '').toUpperCase().includes(q));
      }
      if (leg) rows = rows.filter((e) => e.leg === leg);
      if (decision) rows = rows.filter((e) => e.decision === decision);
      const n = clamp(limit, 20, 100);
      return {
        available: true, total_matching: rows.length,
        entries: rows.slice(-n).map((e) => ({
          at: e.at, leg: e.leg, subject: e.subject, subject_id: e.subject_id,
          decision: e.decision, rule: e.rule, reason: e.reason,
          confidence: e.confidence, counterpart: e.counterpart,
        })),
      };
    },
  };

  return {
    defs: TOOL_DEFS,
    names: Object.keys(impl),
    call(name, input) {
      const fn = impl[name];
      if (!fn) return { error: `no such tool: ${name}` };
      try {
        return fn(input ?? {});
      } catch (err) {
        return { error: `${name} failed: ${err?.message ?? err}` };
      }
    },
  };
}
