// Plain-English explanations for exceptions the engine has already decided.
//
// The boundary matters more than the code: this layer never decides anything.
// By the time an exception reaches it, the reason code, the confidence and the
// counterpart records are all fixed. All the model does is turn a row of
// structured facts into two sentences a finance-ops person can act on without
// knowing what "B2_batch_utr_within_tolerance" means.
//
// Keeping the model out of the matching itself is the whole point. A model that
// is 97% right about a settlement is 3% wrong about a bank balance, and there is
// no way to audit which 3%. A model that writes a bad sentence is a bad sentence.
//
// Every explanation is also available without an API key: the template path
// below produces a slightly stiffer version of the same content, so the demo
// degrades in quality rather than breaking.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { formatPaise } from '../lib/money.js';
import { REASON, REASON_LABEL } from '../match/codes.js';

const MODEL = 'claude-opus-5';

// Sits ahead of every request and never changes, so it is one cached prefix
// across the whole batch — the per-exception facts go in the user turn, after
// the breakpoint. Reversing that would make every call a cache miss.
const SYSTEM_PROMPT = `You are writing exception notes for the reconciliation report a Razorpay merchant's finance team reads every morning.

Context you can rely on:

A merchant has three records of the same money. Their own ledger says an invoice was raised for an amount on a date. Razorpay says it captured a payment, took a fee plus 18% GST on that fee, and paid out the remainder. The bank says a credit landed with a UTR. Razorpay batches every payment captured on a day into one payout under one UTR, so a single bank credit usually settles many invoices at once, and the credited amount is never the invoice amount — it is the total of (amount - fee - tax) across the batch.

A deterministic rules engine has already matched what it could and has decided this record cannot be matched confidently. It has assigned a reason code. That decision is final and is not yours to revisit.

Your job is to write the note a human reads next to the flagged row.

Write:
- explanation: two sentences at most. What is wrong, in terms of the merchant's own records. Name the concrete numbers, dates and references from the data — a reader should not have to open another screen to understand the problem. Never mention rule names, confidence scores, thresholds, or the matching algorithm.
- suggested_action: one sentence. The specific next thing a person should do — which record to open, who to contact, what to compare. Not "investigate further".
- severity: high if money is missing, duplicated, or at risk of being booked twice. medium if the amounts disagree or the money is late but accounted for. low if it is a bookkeeping gap with no cash impact.

Rules:
- All amounts are given in rupees. Write them as Rs 1,23,456.78.
- Never speculate about causes you have no evidence for. If the data does not say why, describe what is observably true.
- Do not suggest that the record is actually fine, and do not propose auto-clearing it. It was flagged because the engine could not confirm it.
- Plain English. No jargon, no hedging, no preamble.`;

const REASON_GUIDANCE = {
  [REASON.AMOUNT_MISMATCH]:
    'The two records refer to the same transaction but the amounts differ by more than rounding. Say which side is higher and by how much.',
  [REASON.MISSING_COUNTERPART]:
    'One side of the reconciliation has no counterpart at all. Say which record exists and which is missing.',
  [REASON.DUPLICATE_UTR]:
    'The same payout reference was credited to the bank more than once, so the cash position is overstated. This is urgent.',
  [REASON.DATE_OUT_OF_WINDOW]:
    'Razorpay reports it paid out, but the credit reached the bank far later than the normal settlement cycle. The amount may be correct; the timing is not.',
  [REASON.AMBIGUOUS_CANDIDATES]:
    'Several payments match this invoice equally well on amount and date, and nothing distinguishes them. The engine refused to guess. Say what the human needs in order to break the tie.',
  [REASON.UNRESOLVED]:
    'The record did not fall into any known category. Describe what is known about it.',
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string' },
    suggested_action: { type: 'string' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['explanation', 'suggested_action', 'severity'],
  additionalProperties: false,
};

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * The facts the model is allowed to see. Deliberately narrow: only the record
 * under review and its immediate counterparts, with amounts already converted to
 * rupees so the model never does arithmetic on paise.
 */
export function buildFacts(row, { group, payment } = {}) {
  const rupees = (p) => (typeof p === 'number' ? formatPaise(p) : null);
  const facts = {
    record_type: 'invoice',
    invoice_id: row.invoice_id,
    customer: row.customer || null,
    invoice_date: row.date,
    ledger_amount_rupees: rupees(row.ledger_amount),
    gateway_reference_on_ledger: row.order_ref || null,
    reason_code: row.reason,
    reason_label: REASON_LABEL[row.reason] ?? row.reason,
  };

  if (payment ?? row.payment_id) {
    facts.matched_payment = {
      payment_id: row.payment_id,
      captured_date: payment?.date ?? null,
      captured_amount_rupees: rupees(row.payment_amount),
      razorpay_fee_rupees: rupees(row.fee),
      gst_on_fee_rupees: rupees(row.tax),
      net_paid_out_rupees: rupees(row.net),
      difference_ledger_minus_gateway_rupees: rupees(row.delta),
    };
  } else {
    facts.matched_payment = null;
    facts.note = 'No Razorpay payment could be linked to this invoice.';
  }

  if (row.utr) facts.settlement_utr = row.utr;
  if (row.settled_date) facts.razorpay_settled_date = row.settled_date;

  if (group) {
    facts.settlement_batch = {
      utr: group.utr,
      invoices_in_batch: group.payment_ids?.length ?? null,
      expected_credit_rupees: rupees(group.expected_credit),
      actually_credited_rupees: rupees(group.credited),
      bank_transactions: group.bank_txn_ids ?? [],
      batch_status: group.status,
      batch_reason: group.reason,
    };
    if (group.detail?.gap_days !== undefined) {
      facts.settlement_batch.days_between_payout_and_credit = group.detail.gap_days;
    }
    if (group.detail?.credits) facts.settlement_batch.individual_credits_rupees = group.detail.credits.map(rupees);
  }

  return facts;
}

/**
 * Deterministic fallback. Used when there is no API key, when a call fails, and
 * as the golden reference the model's output is compared against by a human.
 * Stiffer prose, identical facts — the report is never empty.
 */
export function templateExplanation(row, facts) {
  const rs = (v) => (v ? `Rs ${v}` : 'an unknown amount');
  const p = facts.matched_payment;
  const b = facts.settlement_batch;

  switch (row.reason) {
    case REASON.AMOUNT_MISMATCH:
      if (p) {
        return {
          explanation: `Invoice ${facts.invoice_id} is booked at ${rs(facts.ledger_amount_rupees)} but Razorpay captured ${rs(p.captured_amount_rupees)} against the same order reference. The two records are the same transaction, so one of the amounts was entered wrong.`,
          suggested_action: `Open invoice ${facts.invoice_id} and compare it against payment ${p.payment_id} in the Razorpay dashboard, then correct whichever side is wrong.`,
          severity: 'medium',
        };
      }
      return {
        explanation: `The bank credited ${rs(b?.actually_credited_rupees)} against UTR ${b?.utr}, but Razorpay reported a payout of ${rs(b?.expected_credit_rupees)} for that batch. The shortfall is not explained by gateway fees or GST, which are already accounted for.`,
        suggested_action: `Ask the bank what was deducted from the credit for UTR ${b?.utr}.`,
        severity: 'medium',
      };

    case REASON.MISSING_COUNTERPART:
      return {
        explanation: `Invoice ${facts.invoice_id} for ${rs(facts.ledger_amount_rupees)} dated ${facts.invoice_date} has no matching Razorpay payment. Either it was settled outside the gateway, or the money was never collected.`,
        suggested_action: `Check with ${facts.customer || 'the customer'} whether invoice ${facts.invoice_id} was paid by cash, cheque or direct transfer, and record the method against it.`,
        severity: 'high',
      };

    case REASON.DUPLICATE_UTR:
      return {
        explanation: `UTR ${b?.utr} was credited to the bank ${b?.bank_transactions?.length ?? 2} times, but Razorpay only paid it out once. The bank balance is currently overstated, and invoice ${facts.invoice_id} sits inside that batch.`,
        suggested_action: `Compare bank transactions ${(b?.bank_transactions ?? []).join(' and ')} and have the bank reverse the duplicate posting before this month's books are closed.`,
        severity: 'high',
      };

    case REASON.DATE_OUT_OF_WINDOW:
      return {
        explanation: `Razorpay settled UTR ${b?.utr} on ${facts.razorpay_settled_date}, but the credit did not reach the bank until ${b?.days_between_payout_and_credit} days later. Invoice ${facts.invoice_id} is in that batch, so its money is not yet confirmed as received on the expected date.`,
        suggested_action: `Confirm the credit for UTR ${b?.utr} has now landed, and move it to the correct accounting period if it crossed a month end.`,
        severity: 'medium',
      };

    case REASON.AMBIGUOUS_CANDIDATES:
      return {
        explanation: `Invoice ${facts.invoice_id} for ${rs(facts.ledger_amount_rupees)} on ${facts.invoice_date} matches more than one Razorpay payment equally well, and the invoice has no gateway reference to break the tie. Assigning it to either payment would be a guess.`,
        suggested_action: `Look up the customer name on the candidate payments in the Razorpay dashboard and link invoice ${facts.invoice_id} to the right one by hand.`,
        severity: 'medium',
      };

    default:
      return {
        explanation: `Invoice ${facts.invoice_id} for ${rs(facts.ledger_amount_rupees)} could not be reconciled and does not fall into a known exception category.`,
        suggested_action: `Review invoice ${facts.invoice_id} manually against the Razorpay dashboard and the bank statement.`,
        severity: 'medium',
      };
  }
}

/**
 * Unexplained bank credits have no invoice behind them, so they get their own
 * shape. Money arriving that nobody can account for is a real finding, and a
 * report that only walks the invoice list would never surface it.
 */
export function buildBankFacts(bankRow) {
  return {
    record_type: 'bank_credit',
    bank_transaction_id: bankRow.txn_id,
    value_date: bankRow.date,
    credited_rupees: formatPaise(bankRow.credit),
    utr_on_statement: bankRow.utr || null,
    narration: bankRow.description,
    reason_code: bankRow.reason,
    reason_label: REASON_LABEL[bankRow.reason] ?? bankRow.reason,
    note: 'This credit is in the bank statement but Razorpay never issued a settlement with this UTR.',
  };
}

function templateBankExplanation(bankRow, facts) {
  return {
    explanation: `A credit of Rs ${facts.credited_rupees} landed on ${facts.value_date} under reference ${facts.utr_on_statement || 'an unrecognised reference'}, but Razorpay never issued a settlement with that UTR. This money is in the account and is not attributable to any gateway payout.`,
    suggested_action: `Trace bank transaction ${facts.bank_transaction_id} in the statement narration to find who sent it, and book it against the correct invoice or income head.`,
    severity: 'high',
  };
}

const factsHash = (facts) => createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16);

/**
 * Explains one exception. Returns the template version on any failure — a
 * missing key, a rate limit, a refusal — because a reconciliation report with a
 * blank reason column is worse than one written stiffly.
 */
export async function explainOne(client, row, context = {}) {
  const isBank = context.kind === 'bank';
  const facts = isBank ? buildBankFacts(row) : buildFacts(row, context);
  const template = () => (isBank ? templateBankExplanation(row, facts) : templateExplanation(row, facts));
  if (!client) return { ...template(), source: 'template', facts_hash: factsHash(facts) };

  const guidance = REASON_GUIDANCE[row.reason] ?? REASON_GUIDANCE[REASON.UNRESOLVED];

  try {
    const response = await client.messages.create({
      model: MODEL,
      // Two short sentences plus an action. The ceiling only has to cover a
      // little thinking and a small JSON object.
      max_tokens: 2048,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: {
        // This is a formatting task over facts that are already decided, not a
        // reasoning task. Low effort keeps it fast and cheap across a whole
        // batch of exceptions.
        effort: 'low',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      messages: [{
        role: 'user',
        content: `Reason code: ${row.reason} — ${guidance}\n\nRecord under review:\n${JSON.stringify(facts, null, 2)}`,
      }],
    });

    if (response.stop_reason === 'refusal') {
      return { ...template(), source: 'template', fallback_reason: 'refusal', facts_hash: factsHash(facts) };
    }

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text);
    return {
      explanation: parsed.explanation,
      suggested_action: parsed.suggested_action,
      severity: parsed.severity,
      source: 'llm',
      model: MODEL,
      facts_hash: factsHash(facts),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
      },
    };
  } catch (err) {
    return {
      ...template(),
      source: 'template',
      fallback_reason: err?.message ?? String(err),
      facts_hash: factsHash(facts),
    };
  }
}

/**
 * Explains a batch of exceptions.
 *
 * Concurrency is capped rather than unbounded: the cached system prefix only
 * becomes readable once the first response starts streaming, so firing every
 * request at once means every one of them pays the full uncached price. One
 * request first, then the rest in a bounded pool.
 */
export async function explainAll(rows, { concurrency = 4, client = null, onProgress = () => {} } = {}) {
  const api = client ?? (hasApiKey() ? new Anthropic() : null);
  const results = new Array(rows.length);
  if (rows.length === 0) return results;

  // Warm the prompt cache on a single request before fanning out.
  results[0] = await explainOne(api, rows[0].row, rows[0].context);
  onProgress(1, rows.length);

  let cursor = 1;
  let done = 1;
  const worker = async () => {
    while (cursor < rows.length) {
      const i = cursor++;
      results[i] = await explainOne(api, rows[i].row, rows[i].context);
      onProgress(++done, rows.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length - 1) }, worker));

  return results;
}

export { MODEL, SYSTEM_PROMPT };
