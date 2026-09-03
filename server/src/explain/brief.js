// The month-end brief: one paragraph the merchant reads before the table.
//
// The exception notes explain one row each. Nobody opens a reconciliation and
// wants forty rows explained — they want to know whether the month is fine, and
// if not, what to do first. That is a question about the shape of the whole run,
// so it is one call over the aggregate rather than one call per record.
//
// Same boundary as everywhere else: the engine decided what is flagged and why.
// This layer only decides what to say first.

import Anthropic from '@anthropic-ai/sdk';
import { formatPaise } from '../lib/money.js';
import { REASON, REASON_LABEL, STATUS } from '../match/codes.js';

const MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You write the opening brief on a payment reconciliation, for the person who owns the merchant's cash position. They will read this and nothing else if the month is fine, so it has to be honest about whether it is.

Context: the merchant collects through Razorpay. Razorpay takes a fee plus 18% GST on that fee and batches a day of payments into one payout under one UTR, so a bank credit settles many invoices at once and never equals a single invoice amount. A deterministic engine has already matched everything it could prove and flagged the rest with a reason code. Those decisions are final.

Write:
- headline: one sentence, under 20 words. The state of the month as a person would say it out loud. Lead with the number that matters.
- state_of_the_month: two or three sentences. What reconciled cleanly, what did not, and whether the flagged value is concentrated in a few records or spread thin. Name real figures.
- needs_attention: three to five items, ordered by what to do first. Each has a title of at most eight words that names the action, a detail of one or two sentences with the specific records and amounts, and a severity. Group records that share a cause into one item rather than listing them separately — five invoices flagged because one payout was short-credited is ONE problem, not five.
- biggest_single_risk: one sentence naming the single record or batch that would cost the most if ignored, with its identifier.

Rules:
- Use only the figures given. Never compute a new total, never estimate, never mention a record that is not in the data below.
- Amounts as Rs 1,23,456.78.
- A clean month should read as a clean month. Do not manufacture concern to fill the fields.
- Never suggest that a flagged record is probably fine or can be cleared without review.
- No jargon, no rule names, no confidence scores, no preamble.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    state_of_the_month: { type: 'string' },
    needs_attention: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'detail', 'severity'],
        additionalProperties: false,
      },
    },
    biggest_single_risk: { type: 'string' },
  },
  required: ['headline', 'state_of_the_month', 'needs_attention', 'biggest_single_risk'],
  additionalProperties: false,
};

/**
 * The aggregate the brief is written from. Deliberately not the whole result —
 * the top exceptions by value plus the counts, which is what a human would skim.
 */
export function buildBriefFacts(result, { topN = 12 } = {}) {
  const s = result.summary;
  const rs = (p) => formatPaise(p);

  const invoiceExceptions = result.ledger.filter((l) => l.status === STATUS.EXCEPTION);
  const bankExceptions = result.bank.filter((b) => b.status === STATUS.EXCEPTION);

  const top = [...invoiceExceptions]
    .sort((a, b) => b.ledger_amount - a.ledger_amount)
    .slice(0, topN)
    .map((l) => ({
      invoice_id: l.invoice_id, customer: l.customer || null, date: l.date,
      amount_rupees: rs(l.ledger_amount),
      reason: REASON_LABEL[l.reason] ?? l.reason,
      settlement_utr: l.utr ?? null,
      failing_leg: l.leg_a?.status === STATUS.EXCEPTION ? 'ledger_to_payment'
        : l.leg_b?.status === STATUS.EXCEPTION ? 'settlement_to_bank' : null,
      severity: l.note?.severity ?? null,
    }));

  // Flagged invoices that share a broken payout are one problem wearing many
  // rows. Handing the model the grouping stops the brief listing them one by one.
  const byUTR = new Map();
  for (const l of invoiceExceptions) {
    if (!l.utr || l.leg_b?.status !== STATUS.EXCEPTION) continue;
    const cur = byUTR.get(l.utr) ?? { utr: l.utr, invoices: 0, paise: 0, reason: l.reason };
    byUTR.set(l.utr, { ...cur, invoices: cur.invoices + 1, paise: cur.paise + l.ledger_amount });
  }

  // A payout that arrived late is a bookkeeping problem; a payout that arrived
  // short, twice, or not at all is a cash problem. Rating both "high" would make
  // the severity column carry no information at all.
  const payoutSeverity = (reason) => (reason === REASON.DATE_OUT_OF_WINDOW ? 'medium' : 'high');

  return {
    period: result.dataset?.period ?? null,
    invoices_total: s.ledger_rows,
    invoices_matched: s.matched,
    invoices_flagged: s.exceptions,
    match_rate: `${(s.match_rate * 100).toFixed(1)}%`,
    value_auto_reconciled_rupees: rs(s.value_matched_paise),
    value_flagged_rupees: rs(s.value_flagged_paise),
    exceptions_by_reason: Object.fromEntries(
      Object.entries(s.exceptions_by_reason).map(([k, v]) => [REASON_LABEL[k] ?? k, v]),
    ),
    settlement_batches: s.settlement_groups,
    settlement_batches_confirmed: s.settlements_matched,
    unexplained_bank_credits: s.bank_exceptions,
    unexplained_bank_credit_rupees: rs(s.bank_unexplained_credit_paise),
    broken_payouts: [...byUTR.values()]
      .sort((a, b) => b.paise - a.paise)
      .map((g) => ({ utr: g.utr, invoices_affected: g.invoices, invoice_value_rupees: rs(g.paise),
                     reason: REASON_LABEL[g.reason] ?? g.reason, severity: payoutSeverity(g.reason) })),
    largest_flagged_invoices: top,
    largest_unexplained_credits: [...bankExceptions]
      .sort((a, b) => b.credit - a.credit)
      .slice(0, 5)
      .map((b) => ({ bank_transaction_id: b.txn_id, date: b.date, amount_rupees: rs(b.credit), utr: b.utr || null, narration: b.description })),
  };
}

/** Deterministic brief. Blunter, same facts, always available. */
export function templateBrief(facts) {
  const flaggedCount = facts.invoices_flagged;
  const items = [];

  for (const g of facts.broken_payouts.slice(0, 2)) {
    items.push({
      title: `Chase the bank on payout ${g.utr}`,
      detail: `${g.invoices_affected} invoice(s) worth Rs ${g.invoice_value_rupees} are unconfirmed because the credit for UTR ${g.utr} did not reconcile — ${g.reason}.`,
      severity: g.severity ?? 'high',
    });
  }
  if (facts.unexplained_bank_credits > 0) {
    items.push({
      title: 'Identify unexplained bank credits',
      detail: `Rs ${facts.unexplained_bank_credit_rupees} arrived across ${facts.unexplained_bank_credits} credit(s) with no matching Razorpay settlement. This money is in the account and is not attributed to any invoice.`,
      severity: 'high',
    });
  }
  for (const inv of facts.largest_flagged_invoices.slice(0, 2)) {
    if (items.length >= 5) break;
    items.push({
      title: `Review invoice ${inv.invoice_id}`,
      detail: `Rs ${inv.amount_rupees} dated ${inv.date}${inv.customer ? ` for ${inv.customer}` : ''} — ${inv.reason}.`,
      severity: inv.severity ?? 'medium',
    });
  }
  if (!items.length) {
    items.push({ title: 'Nothing outstanding', detail: 'Every invoice in this period reconciled end to end against Razorpay and the bank.', severity: 'low' });
  }

  // Ordered by what to do first. Stable within a severity, so the largest amounts
  // still lead — the list above is already built in descending value order.
  const rank = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);

  const biggest = facts.broken_payouts[0]
    ? `Payout ${facts.broken_payouts[0].utr} — Rs ${facts.broken_payouts[0].invoice_value_rupees} across ${facts.broken_payouts[0].invoices_affected} invoices is unconfirmed until the bank explains that credit.`
    : facts.largest_flagged_invoices[0]
      ? `Invoice ${facts.largest_flagged_invoices[0].invoice_id} at Rs ${facts.largest_flagged_invoices[0].amount_rupees} is the largest single unreconciled amount.`
      : 'Nothing in this period is at risk.';

  return {
    headline: flaggedCount === 0
      ? `All ${facts.invoices_total} invoices reconciled — Rs ${facts.value_auto_reconciled_rupees} confirmed in the bank.`
      : `${facts.invoices_matched} of ${facts.invoices_total} invoices confirmed; Rs ${facts.value_flagged_rupees} still needs a human.`,
    state_of_the_month: `Rs ${facts.value_auto_reconciled_rupees} reconciled end to end across ${facts.settlement_batches_confirmed} of ${facts.settlement_batches} settlement batches. ${flaggedCount} invoice(s) worth Rs ${facts.value_flagged_rupees} could not be confirmed, and Rs ${facts.unexplained_bank_credit_rupees} of bank credit has no Razorpay settlement behind it.`,
    needs_attention: items.slice(0, 5),
    biggest_single_risk: biggest,
  };
}

/**
 * Writes the brief. Falls back to the template on any failure, for the same
 * reason the exception notes do — a dashboard that opens with an error banner is
 * worse than one that opens with a stiffer sentence.
 */
export async function writeBrief(result, { client, topN = 12 } = {}) {
  const facts = buildBriefFacts(result, { topN });
  const api = client ?? (process.env.ANTHROPIC_API_KEY ? new Anthropic() : null);
  if (!api) return { ...templateBrief(facts), source: 'template', generated_at: new Date().toISOString() };

  try {
    const response = await api.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      // Deciding what to lead with, and which flagged rows share one cause, is a
      // judgement over the whole month rather than a formatting pass.
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content: `Reconciliation for review:\n${JSON.stringify(facts, null, 2)}` }],
    });

    if (response.stop_reason === 'refusal') throw new Error('refusal');
    const parsed = JSON.parse(response.content.find((b) => b.type === 'text')?.text ?? '');
    return {
      ...parsed,
      source: 'llm',
      model: MODEL,
      generated_at: new Date().toISOString(),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
      },
    };
  } catch (err) {
    return { ...templateBrief(facts), source: 'template', fallback_reason: err?.message ?? String(err), generated_at: new Date().toISOString() };
  }
}

export { MODEL, SYSTEM_PROMPT };
