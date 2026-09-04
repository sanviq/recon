import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../src/generate/synth.js';
import { materialize } from '../src/generate/serialize.js';
import { reconcile } from '../src/match/engine.js';
import { buildToolbox, TOOL_DEFS } from '../src/agent/tools.js';
import { ask } from '../src/agent/ask.js';
import { STATUS } from '../src/match/codes.js';

// A real run, so the tools are exercised against the shape the engine actually
// produces rather than a hand-written stand-in that could drift from it.
const dataset = materialize(generateDataset({ seed: 991, profile: 'standard' }), 'memory/agent-test');
const result = { ...reconcile(dataset), dataset: { dir: 'memory/agent-test' } };
const audit = result.audit.map((e, i) => ({ run_id: 'test', seq: i, ...e }));
const toolbox = buildToolbox(result, audit);

const anException = result.ledger.find((l) => l.status === STATUS.EXCEPTION);
const aMatch = result.ledger.find((l) => l.status === STATUS.MATCHED);

test('every declared tool has an implementation, and nothing is implemented in secret', () => {
  assert.deepEqual(TOOL_DEFS.map((t) => t.name).sort(), [...toolbox.names].sort());
});

// The safety claim, asserted rather than promised. If any tool could write, the
// separation between "the agent explains decisions" and "the agent makes them"
// would exist only in the system prompt, where a model can talk its way past it.
test('no tool can mutate the reconciliation it reads', () => {
  const before = JSON.stringify(result);
  const calls = [
    ['reconciliation_summary', {}],
    ['search_exceptions', {}],
    ['search_exceptions', { reason: anException.reason, limit: 100 }],
    ['get_invoice', { invoice_id: anException.invoice_id }],
    ['get_invoice', { invoice_id: aMatch.invoice_id }],
    ['get_settlement_batch', { utr: result.groups[0].utr }],
    ['list_settlement_batches', {}],
    ['aggregate_exceptions', { group_by: 'reason' }],
    ['aggregate_exceptions', { group_by: 'severity' }],
    ['aggregate_exceptions', { group_by: 'kind' }],
    ['search_audit', { limit: 100 }],
  ];
  for (const [name, input] of calls) toolbox.call(name, input);
  assert.equal(JSON.stringify(result), before);
});

test('the summary reports rupees, never raw paise', () => {
  const s = toolbox.call('reconciliation_summary');
  assert.match(s.value_auto_reconciled_rupees, /^[\d,]+\.\d{2}$/);
  assert.equal(s.invoices_total, result.summary.ledger_rows);
  assert.equal(s.invoices_matched, result.summary.matched);
  assert.match(s.match_rate, /%$/);
});

test('exceptions can be narrowed to one reason code', () => {
  const all = toolbox.call('search_exceptions', { limit: 100 });
  const one = toolbox.call('search_exceptions', { reason: anException.reason, limit: 100 });
  assert.ok(one.total_matching > 0);
  assert.ok(one.total_matching <= all.total_matching);
  assert.ok(one.rows.every((r) => r.reason === anException.reason));
});

test('a limit is honoured and the true total is still reported', () => {
  const r = toolbox.call('search_exceptions', { limit: 2 });
  assert.equal(r.rows.length, Math.min(2, r.total_matching));
  assert.equal(r.total_matching, result.summary.exceptions + result.summary.bank_exceptions);
});

test('an invoice carries its payment, its batch, and which leg broke', () => {
  const inv = toolbox.call('get_invoice', { invoice_id: anException.invoice_id });
  assert.equal(inv.found, true);
  assert.equal(inv.invoice_id, anException.invoice_id);
  assert.ok(['ledger_to_payment', 'settlement_to_bank', null].includes(inv.failing_leg));
  if (inv.razorpay_payment) assert.match(inv.razorpay_payment.captured_amount_rupees ?? '0.00', /\.\d{2}$/);
});

test('invoice lookup is case-insensitive and trims, because people paste', () => {
  const a = toolbox.call('get_invoice', { invoice_id: `  ${anException.invoice_id.toLowerCase()} ` });
  assert.equal(a.found, true);
});

// The failure that matters: a tool that returns nothing for a bad id invites the
// model to fill the silence. An explicit "not here" does not.
test('an unknown id returns found:false rather than throwing or returning empty', () => {
  const inv = toolbox.call('get_invoice', { invoice_id: 'INV-DOES-NOT-EXIST' });
  assert.equal(inv.found, false);
  assert.match(inv.note, /No invoice/);

  const batch = toolbox.call('get_settlement_batch', { utr: 'NOPE123' });
  assert.equal(batch.found, false);
});

test('a settlement batch lists every invoice inside it', () => {
  const g = result.groups.find((x) => x.bank_txn_ids?.length);
  const batch = toolbox.call('get_settlement_batch', { utr: g.utr });
  assert.equal(batch.found, true);
  assert.equal(batch.utr, g.utr);
  const expected = result.ledger.filter((l) => l.utr === g.utr).length;
  assert.equal(batch.invoices_in_batch.length, expected);
});

test('aggregation totals agree with the engine summary', () => {
  const agg = toolbox.call('aggregate_exceptions', { group_by: 'kind' });
  const byKind = Object.fromEntries(agg.groups.map((g) => [g.kind, g.count]));
  assert.equal(byKind.invoice ?? 0, result.summary.exceptions);
  assert.equal(byKind.bank_credit ?? 0, result.summary.bank_exceptions);
});

test('the audit log is traceable by subject', () => {
  const r = toolbox.call('search_audit', { subject_id: anException.invoice_id, limit: 50 });
  assert.equal(r.available, true);
  assert.ok(r.total_matching > 0, 'every decision reaches the trail, so every subject is findable');
});

test('a missing audit log says so instead of returning an empty result', () => {
  const bare = buildToolbox(result, []);
  const r = bare.call('search_audit', {});
  assert.equal(r.available, false);
});

test('a bad tool name and a bad argument both come back as errors, not crashes', () => {
  assert.match(toolbox.call('drop_everything', {}).error, /no such tool/);
  assert.equal(toolbox.call('get_invoice', {}).found, false);
  assert.ok(toolbox.call('aggregate_exceptions', { group_by: 'nonsense' }).error);
});

// ---------------------------------------------------------------------------
// The loop. Stubbed client — these assert the plumbing around a model's turns,
// not the model's judgement.
// ---------------------------------------------------------------------------

function scriptedClient(turns) {
  let i = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        return { usage: { input_tokens: 10, output_tokens: 5 }, ...turns[Math.min(i++, turns.length - 1)] };
      },
    },
  };
}

test('a tool call is executed, fed back, and recorded in the trace', async () => {
  const client = scriptedClient([
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'tu_1', name: 'reconciliation_summary', input: {} },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Rs 1,00,000.00 is flagged.' }] },
  ]);

  const out = await ask('how much is flagged?', { result, audit, client });
  assert.equal(out.answer, 'Rs 1,00,000.00 is flagged.');
  assert.equal(out.trace.length, 1);
  assert.equal(out.trace[0].tool, 'reconciliation_summary');
  assert.equal(out.iterations, 2);
  assert.equal(out.usage.input_tokens, 20);
});

test('the tool result actually reaches the next request', async () => {
  const client = scriptedClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_invoice', input: { invoice_id: anException.invoice_id } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  ]);
  await ask('why?', { result, audit, client });

  const toolResult = client.calls[1].messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === 'tool_result');
  assert.ok(toolResult, 'the second request must carry the result of the first tool call');
  assert.equal(toolResult.tool_use_id, 'tu_1');
  assert.match(toolResult.content, new RegExp(anException.invoice_id));
});

test('the tools are declared to the model and the system prompt is cached', async () => {
  const client = scriptedClient([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
  await ask('hello', { result, audit, client });
  const req = client.calls[0];
  assert.deepEqual(req.tools.map((t) => t.name).sort(), TOOL_DEFS.map((t) => t.name).sort());
  assert.equal(req.system[0].cache_control.type, 'ephemeral');
  assert.equal(req.thinking.type, 'adaptive');
});

test('a runaway loop is cut off and says so rather than answering anyway', async () => {
  const client = scriptedClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu', name: 'reconciliation_summary', input: {} }] },
  ]);
  const out = await ask('loop forever', { result, audit, client, maxIterations: 3 });
  assert.equal(out.stop_reason, 'max_iterations');
  assert.equal(out.iterations, 3);
  assert.match(out.answer, /narrow/i);
});

test('a refusal is handled without pretending an answer exists', async () => {
  const client = scriptedClient([{ stop_reason: 'refusal', content: [] }]);
  const out = await ask('something disallowed', { result, audit, client });
  assert.equal(out.stop_reason, 'refusal');
  assert.ok(out.answer.length > 0);
});

// A stack trace is the first thing anyone sees when their key has a typo, which
// is the single most likely failure on demo day. Every one of these must reach
// the user as a sentence naming the fix.
test('API failures are reported as instructions, not stack traces', async () => {
  const cases = [
    // A bad key must name the env var for the provider that rejected it — telling
    // someone on a free Gemini key to check ANTHROPIC_API_KEY sends them nowhere.
    [{ status: 401, provider: 'anthropic', message: '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}' },
      401, /ANTHROPIC_API_KEY/],
    [{ status: 400, provider: 'gemini', message: 'Gemini returned 400: API key not valid' }, 401, /GEMINI_API_KEY/],
    [{ status: 401, provider: 'groq', message: 'Groq returned 401: Invalid API Key' }, 401, /GROQ_API_KEY/],
    [{ status: 429, message: 'rate_limit_error' }, 429, /Rate limited/i],
    // The free-tier answer to an unfunded account is another provider, not a card.
    [{ status: 400, message: 'Your credit balance is too low' }, 402, /GEMINI_API_KEY|GROQ_API_KEY/],
    [{ status: 529, message: 'overloaded_error' }, 503, /overloaded|unavailable/i],
    [{ message: 'Connection error.' }, 503, /network connection/i],
    [{ status: 404, message: 'model not found' }, 404, /not available/i],
  ];

  for (const [thrown, status, pattern] of cases) {
    const client = { messages: { create: async () => {
      throw Object.assign(new Error(thrown.message), { status: thrown.status, provider: thrown.provider });
    } } };
    await assert.rejects(() => ask('anything', { result, audit, client }), (err) => {
      assert.equal(err.status, status, `wrong status for: ${thrown.message}`);
      assert.match(err.message, pattern);
      assert.doesNotMatch(err.message, /at .*\.mjs:|node_modules/, 'must not leak a stack trace');
      return true;
    });
  }
});

test('an unrecognised failure still says something, rather than throwing raw', async () => {
  const client = { messages: { create: async () => { throw new Error('something entirely new'); } } };
  await assert.rejects(() => ask('anything', { result, audit, client }), (err) => {
    assert.equal(err.status, 502);
    assert.match(err.message, /something entirely new/);
    return true;
  });
});

test('with no provider at all the agent refuses to start, and names the free ones', async () => {
  // Every provider has to be cleared, not just Anthropic — the point of the chain
  // is that any one key is enough, so the refusal only happens when none is set.
  const vars = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY'];
  const saved = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
  for (const v of vars) delete process.env[v];
  try {
    await assert.rejects(() => ask('anything', { result, audit }), (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /GEMINI_API_KEY/, 'must point at a free option, not only the paid one');
      assert.match(err.message, /GROQ_API_KEY/);
      assert.match(err.message, /dashboard, matching and exception notes all work/);
      return true;
    });
  } finally {
    for (const v of vars) if (saved[v] !== undefined) process.env[v] = saved[v];
  }
});
