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

import { getClient } from '../llm/client.js';
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
 * Turns an SDK error into a sentence a person can act on.
 *
 * The explainer can absorb a failed call by falling back to a template. This
 * layer cannot — there is no canned answer to an arbitrary question — so the
 * failure reaches the user, and it should say what to do rather than print a
 * stack trace over a dashboard.
 */
export function friendlyApiError(err) {
  const status = err?.status ?? err?.statusCode;
  const raw = String(err?.message ?? err);
  const provider = err?.provider ?? 'the model provider';
  const keyName = { anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY' }[err?.provider] ?? 'the API key';
  const wrap = (message, code) => Object.assign(new Error(message), { status: code, cause: err, provider: err?.provider });

  // Every provider is tried before the error surfaces, so a message naming all of
  // them means the chain is exhausted rather than one key being wrong.
  if (err?.failures?.length > 1) {
    return wrap(`Every configured model provider failed. ${err.failures.join(' | ')}. The dashboard, matching, exception notes and audit trail all still work — only this chat is affected.`, status ?? 503);
  }

  if (status === 401 || /authentication_error|invalid x-api-key|API key is invalid|api key not valid/i.test(raw)) {
    return wrap(`${provider} rejected the API key. Check ${keyName} in .env — no quotes, no trailing spaces.`, 401);
  }
  if (status === 403) return wrap(`That ${provider} key is not permitted to use this model.`, 403);
  if (status === 429 || /rate_limit|quota|RESOURCE_EXHAUSTED/i.test(raw)) {
    return wrap(`Rate limited by ${provider} — free tiers cap requests per minute. Wait about a minute and ask again, or set a second provider key in .env so the next question falls through to it.`, 429);
  }
  if (/credit balance|insufficient|billing/i.test(raw)) {
    return wrap(`The ${provider} account has no credit left. Either add credit, or put a free GEMINI_API_KEY or GROQ_API_KEY in .env — this project falls through to whichever provider works.`, 402);
  }
  if (status === 404 || /model.*not found|no model/i.test(raw)) {
    return wrap(raw.includes('Set ') ? raw : `That model is not available to this ${provider} account.`, 404);
  }
  if (status >= 500 || /overloaded/i.test(raw)) {
    return wrap(`${provider} is overloaded or unavailable right now. The reconciliation, exception notes and audit trail all still work — only this chat is affected.`, 503);
  }
  // The SDK reports a dead socket as the bare string "Connection error.", which
  // is not something anyone can act on without being told what it means.
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|connection error/i.test(raw)) {
    return wrap('Could not reach the model provider — check the network connection.', 503);
  }
  return wrap(`The chat request failed: ${raw}`, 502);
}

/**
 * Answers one question against a loaded result.
 *
 * `history` is prior [{role, content}] turns as plain strings, so the caller
 * owns conversation state and this function stays a pure function of its inputs.
 */
export async function ask(question, { result, audit = [], history = [], client, maxIterations = MAX_ITERATIONS } = {}) {
  // One retry, not the free tier's patient seven.
  //
  // The batch paths can afford to sit out a per-minute quota: nobody is watching
  // `npm run explain` and a note that arrives 40s late is still a note. A person
  // waiting at a chat box is a different problem entirely — a rate-limited Gemini
  // was costing a full minute of backoff before the chain even tried Groq, and a
  // minute of silence reads as broken. Failing over fast is worth more here than
  // holding out for the preferred provider.
  const api = client ?? getClient({ maxRetries: 1 });
  if (!api) {
    const err = new Error('No model provider is configured — the controller agent needs a key. Set any one of ANTHROPIC_API_KEY, GEMINI_API_KEY (free, aistudio.google.com) or GROQ_API_KEY (free, console.groq.com) in .env. The dashboard, matching and exception notes all work without one.');
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
    let response;
    try {
      response = await api.messages.create({
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
    } catch (err) {
      throw friendlyApiError(err);
    }

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
