// The controller agent: ask the reconciliation a question in English.
//
// This is the second place a model touches the product, and it is the same
// bargain as the first. The engine has already decided where every rupee went.
// The agent can read those decisions, in any combination, and say what it found —
// it cannot make one. Its entire tool surface is read-only by construction (see
// tools.js), so "the model must not clear an exception" is not an instruction it
// could disobey; there is no tool that clears anything.
//
// The loop is written out by hand rather than handed to the SDK's tool runner,
// because the trace is half the point. Every tool call and every argument is
// captured and returned alongside the answer, so a reader can see which records
// the answer was actually built from instead of taking the prose on faith.

import Anthropic from '@anthropic-ai/sdk';
import { buildToolbox } from './tools.js';

const MODEL = 'claude-opus-5';
const MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `You answer questions about a finished payment reconciliation for an Indian merchant who collects through Razorpay. You are talking to the person who has to act on it — a finance-ops lead or the founder — not to an engineer.

How the money works, so you read the numbers correctly:
- The merchant's ledger records invoices at their gross amount.
- Razorpay captures a payment, takes a percentage fee plus 18% GST on that fee, and pays out the remainder.
- Razorpay batches every payment captured on a day into ONE payout under ONE UTR, typically two days later. So a single bank credit settles many invoices at once, and the credited amount never equals any one invoice amount. It equals the sum of (amount - fee - tax) across the whole batch.
- An invoice is only reconciled if both legs hold: the ledger row matched a Razorpay payment, AND that payment's batch was confirmed against a real bank credit. An invoice can match its payment perfectly and still be flagged because the batch it sits in was short-credited, duplicated, or late. When that happens, the problem is the batch, not the invoice — say so.

How you work:
- Answer from tool results only. Never state a number, id, date or amount that a tool did not return. If you need a figure, call a tool for it; do not estimate, extrapolate, or carry a number over from an earlier question.
- Call several tools when a question needs them. A question about one invoice usually needs get_invoice and then get_settlement_batch for the batch behind it.
- If the tools do not contain the answer, say exactly that and name what would be needed. Never fill a gap with a plausible guess.
- The engine's decisions are final and not yours to revisit. You may explain why a record was flagged. You must never suggest it is actually fine, that it can be cleared, or that the merchant can ignore it.
- You are describing what happened to money that already moved. Do not give investment, tax or accounting advice.

How you write:
- Lead with the answer. One or two sentences, then the supporting detail.
- Amounts as Rs 1,23,456.78. Always name the invoice id, UTR or transaction id behind a claim so the reader can go look at it.
- Short markdown is fine — a few bullets or a small table when you are listing records. No headings, no preamble, no restating the question.
- No rule names, confidence scores or internal jargon unless the user asks how a decision was made. "Matched on the gateway reference" beats "A1_exact_order_ref fired".`;

/**
 * Answers one question against a loaded result.
 *
 * `history` is prior [{role, content}] turns as plain strings, so the caller
 * owns conversation state and this function stays a pure function of its inputs.
 */
export async function ask(question, { result, audit = [], history = [], client, maxIterations = MAX_ITERATIONS } = {}) {
  const api = client ?? (process.env.ANTHROPIC_API_KEY ? new Anthropic() : null);
  if (!api) {
    const err = new Error('ANTHROPIC_API_KEY is not set — the controller agent needs a key. The dashboard, matching and exception notes all work without one.');
    err.status = 503;
    throw err;
  }

  const toolbox = buildToolbox(result, audit);
  const messages = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];

  const trace = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;
    const response = await api.messages.create({
      model: MODEL,
      max_tokens: 8192,
      // Reading a settlement batch, noticing the invoice inside it matched fine,
      // and concluding the batch is the real problem is a chain of steps. Adaptive
      // thinking lets it spend where the question is genuinely multi-hop and skip
      // it on "how much is flagged".
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: toolbox.defs,
      messages,
    });

    for (const k of Object.keys(usage)) usage[k] += response.usage?.[k] ?? 0;

    // Thinking blocks have to survive into the next request unmodified for the
    // model to keep its own reasoning across tool calls.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      return { answer: 'I could not answer that one. Try rephrasing, or ask about a specific invoice, UTR or reason code.', trace, usage, iterations, stop_reason: 'refusal' };
    }

    if (response.stop_reason !== 'tool_use') {
      const answer = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { answer, trace, usage, iterations, stop_reason: response.stop_reason };
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const t0 = performance.now();
      const output = toolbox.call(block.name, block.input);
      trace.push({
        tool: block.name,
        input: block.input,
        ms: Number((performance.now() - t0).toFixed(2)),
        rows: output?.rows?.length ?? output?.entries?.length ?? output?.groups?.length ?? null,
        error: output?.error ?? null,
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(output),
        is_error: Boolean(output?.error),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Hitting the ceiling means the question was open-ended enough to keep pulling
  // records. Saying so is better than returning whatever half-answer exists.
  return {
    answer: `I looked at ${trace.length} slices of the data and still could not close this out. Try narrowing it — a specific invoice, a UTR, or one reason code.`,
    trace, usage, iterations, stop_reason: 'max_iterations',
  };
}

export { MODEL, SYSTEM_PROMPT, MAX_ITERATIONS };
