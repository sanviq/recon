import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiClient, toGeminiSchema, toGeminiContents, fromGeminiResponse } from '../src/llm/gemini.js';
import { groqClient, toOpenAIMessages, fromOpenAIResponse } from '../src/llm/groq.js';
import { getClient, parseModelJson, isPermanentFailure, availableProviders, describeProviders } from '../src/llm/client.js';
import { generateDataset } from '../src/generate/synth.js';
import { materialize } from '../src/generate/serialize.js';
import { reconcile } from '../src/match/engine.js';
import { ask } from '../src/agent/ask.js';

// A stub fetch that records what it was sent and replays a canned reply. The
// adapters are pure translation, so this is the whole surface that needs proving:
// no key is required to know whether the shape is right.
function stubFetch(reply, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    };
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

// Every strict schema in this repo sets additionalProperties:false, which Anthropic
// requires and Gemini rejects outright. Leaving it in place is a 400 on every
// single call — the failure would look like "the free tier doesn't work".
test('a strict Anthropic schema is rewritten into something Gemini will accept', () => {
  const out = toGeminiSchema({
    type: 'object',
    additionalProperties: false,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      explanation: { type: 'string', description: 'why' },
      severity: { type: 'string', enum: ['high', 'medium', 'low'] },
      utr: { type: ['string', 'null'] },
      rows: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } } },
    },
    required: ['explanation', 'severity'],
  });

  assert.equal(JSON.stringify(out).includes('additionalProperties'), false);
  assert.equal(JSON.stringify(out).includes('$schema'), false);
  assert.deepEqual(out.required, ['explanation', 'severity']);
  assert.deepEqual(out.properties.severity.enum, ['high', 'medium', 'low']);
  // A JSON Schema union becomes a single type plus a nullable flag.
  assert.equal(out.properties.utr.type, 'string');
  assert.equal(out.properties.utr.nullable, true);
  assert.equal(out.properties.rows.items.properties.id.type, 'string');
});

test('system blocks become a systemInstruction and a json schema becomes a responseSchema', async () => {
  const fetchImpl = stubFetch({
    candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 },
  });
  const client = geminiClient({ apiKey: 'k', model: 'gemini-test', fetchImpl });

  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 512,
    system: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } } } },
    messages: [{ role: 'user', content: 'hello' }],
  });

  const sent = fetchImpl.calls[0].body;
  assert.equal(sent.systemInstruction.parts[0].text, 'be terse');
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  assert.equal(sent.generationConfig.maxOutputTokens, 512);
  assert.equal(sent.contents[0].parts[0].text, 'hello');

  // The caller's model name is not forwarded — the adapter owns that.
  assert.equal(response.model, 'gemini-test');
  assert.equal(response.usage.input_tokens, 11);
  assert.equal(response.content[0].text, '{"ok":true}');
  assert.equal(response.stop_reason, 'end_turn');
});

// Gemini keys a tool result by the tool's NAME, but a tool_result block carries
// only the id of the call. If that lookup is wrong the model is told the answer
// to a question it never asked.
test('a tool result is paired back to the name of the call that produced it', () => {
  const contents = toGeminiContents([
    { role: 'user', content: 'why is INV-1 flagged?' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'dropped' },
      { type: 'tool_use', id: 'call_7', name: 'get_invoice', input: { invoice_id: 'INV-1' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_7', content: '{"invoice_id":"INV-1"}' }] },
  ]);

  assert.equal(contents[1].role, 'model');
  assert.equal(contents[1].parts[0].functionCall.name, 'get_invoice');
  assert.equal(contents[1].parts.length, 1, 'the Anthropic-only thinking block is dropped');
  assert.equal(contents[2].parts[0].functionResponse.name, 'get_invoice');
  assert.deepEqual(contents[2].parts[0].functionResponse.response, { invoice_id: 'INV-1' });
});

test('a tool result that is an array is wrapped, because Gemini demands an object', () => {
  const contents = toGeminiContents([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search_exceptions', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '[1,2,3]' }] },
  ]);
  assert.deepEqual(contents[1].parts[0].functionResponse.response, { result: [1, 2, 3] });
});

test('a Gemini function call becomes a tool_use block with an id the loop can pair', () => {
  const out = fromGeminiResponse({
    candidates: [{ content: { parts: [
      { text: 'looking that up' },
      { functionCall: { name: 'get_invoice', args: { invoice_id: 'INV-9' } } },
    ] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
  }, 'gemini-test');

  assert.equal(out.stop_reason, 'tool_use');
  const call = out.content.find((b) => b.type === 'tool_use');
  assert.equal(call.name, 'get_invoice');
  assert.deepEqual(call.input, { invoice_id: 'INV-9' });
  assert.ok(call.id, 'Gemini issues no id, so the adapter must mint one');
});

test('a safety block is reported as a refusal, which the callers already handle', () => {
  const out = fromGeminiResponse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }, 'm');
  assert.equal(out.stop_reason, 'refusal');
});

test('an HTTP failure carries its status and provider so the error message can name them', async () => {
  const fetchImpl = stubFetch({ error: { message: 'API key not valid' } }, { status: 400 });
  const client = geminiClient({ apiKey: 'bad', model: 'gemini-test', fetchImpl });
  await assert.rejects(() => client.messages.create({ messages: [{ role: 'user', content: 'x' }] }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.provider, 'gemini');
    return true;
  });
});

// A stale model name is the likeliest thing to break on a free tier, and a bare
// 404 tells the user nothing they can act on.
test('an unknown model is answered with the list of models the key can actually use', async () => {
  let call = 0;
  const fetchImpl = async (url) => {
    call++;
    if (call === 1) return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
    ] }) };
  };
  const client = geminiClient({ apiKey: 'k', model: 'gemini-does-not-exist', fetchImpl });
  await assert.rejects(() => client.messages.create({ messages: [{ role: 'user', content: 'x' }] }), (err) => {
    assert.match(err.message, /GEMINI_MODEL/);
    assert.match(err.message, /gemini-2\.5-flash/);
    assert.doesNotMatch(err.message, /embedding-001/, 'a model that cannot generate is not a suggestion');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Groq
// ---------------------------------------------------------------------------

test('tool calls and results are moved into the roles OpenAI expects', () => {
  const out = toOpenAIMessages([
    { role: 'user', content: 'why?' },
    { role: 'assistant', content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'c1', name: 'get_invoice', input: { invoice_id: 'INV-1' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c1', content: '{"a":1}' },
      { type: 'tool_result', tool_use_id: 'c2', content: '{"b":2}' },
    ] },
  ], 'be terse');

  assert.equal(out[0].role, 'system');
  assert.equal(out[2].role, 'assistant');
  assert.equal(out[2].tool_calls[0].function.name, 'get_invoice');
  assert.equal(out[2].tool_calls[0].function.arguments, '{"invoice_id":"INV-1"}');
  // Anthropic bundles several results into one turn; OpenAI needs one message each.
  assert.equal(out[3].role, 'tool');
  assert.equal(out[3].tool_call_id, 'c1');
  assert.equal(out[4].tool_call_id, 'c2');
});

test('a schema is restated in the prompt, because JSON mode guarantees syntax and not shape', async () => {
  const fetchImpl = stubFetch({
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  });
  const client = groqClient({ apiKey: 'k', model: 'llama-test', fetchImpl });
  await client.messages.create({
    max_tokens: 256,
    system: [{ type: 'text', text: 'be terse' }],
    output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
    messages: [{ role: 'user', content: 'hi' }],
  });

  const sent = fetchImpl.calls[0].body;
  assert.equal(sent.response_format.type, 'json_object');
  assert.match(sent.messages[0].content, /be terse/);
  assert.match(sent.messages[0].content, /"ok"/, 'the schema itself has to reach the model');
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer k');
});

test('unparseable tool arguments become an empty object rather than a thrown error', () => {
  const out = fromOpenAIResponse({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'get_invoice', arguments: '{not json' } }] }, finish_reason: 'tool_calls' }],
    usage: {},
  }, 'llama-test');
  assert.equal(out.stop_reason, 'tool_use');
  assert.deepEqual(out.content[0].input, {});
});

// ---------------------------------------------------------------------------
// Tolerant JSON
// ---------------------------------------------------------------------------

test('JSON survives the fences and preamble that open models wrap it in', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Sure! Here is the note:\n{"a":1}\nHope that helps.'), { a: 1 });
  assert.throws(() => parseModelJson('no json at all'), /did not return JSON/);
  assert.throws(() => parseModelJson(''), /returned nothing/);
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

test('a dead provider is skipped, and a rate-limited one is not', () => {
  assert.equal(isPermanentFailure({ status: 401 }), true);
  assert.equal(isPermanentFailure({ status: 404 }), true);
  assert.equal(isPermanentFailure({ status: 400, message: 'Your credit balance is too low' }), true);
  assert.equal(isPermanentFailure({ status: 429, message: 'rate limited' }), false, 'a quota resets; dropping the provider would waste it');
  assert.equal(isPermanentFailure({ status: 500, message: 'overloaded' }), false);
  // A malformed request about one record must not disable the provider for the rest.
  assert.equal(isPermanentFailure({ status: 400, message: 'invalid schema for field severity' }), false);
});

test('an unfunded provider hands over to the free one, and is not asked again', async () => {
  let paidCalls = 0;
  let freeCalls = 0;
  const legs = [
    { name: 'anthropic', model: 'claude-opus-5', client: { messages: { create: async () => {
      paidCalls++;
      throw Object.assign(new Error('Your credit balance is too low'), { status: 400 });
    } } } },
    { name: 'gemini', model: 'gemini-test', client: { messages: { create: async () => {
      freeCalls++;
      return { model: 'gemini-test', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} };
    } } } },
  ];
  const chain = getClient({ clients: legs });

  for (let i = 0; i < 3; i++) await chain.messages.create({ messages: [] });

  assert.equal(paidCalls, 1, 'the unfunded provider is tried once and then dropped for the process');
  assert.equal(freeCalls, 3);
  assert.equal(chain.provider, 'gemini');
  assert.deepEqual(chain.used, ['gemini']);
});

test('a rate limit falls through without retiring the provider', async () => {
  let firstCalls = 0;
  const legs = [
    { name: 'gemini', model: 'g', client: { messages: { create: async () => {
      firstCalls++;
      throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
    } } } },
    { name: 'groq', model: 'l', client: { messages: { create: async () => ({ model: 'l', content: [], stop_reason: 'end_turn', usage: {} }) } } },
  ];
  const chain = getClient({ clients: legs });
  await chain.messages.create({ messages: [] });
  await chain.messages.create({ messages: [] });
  assert.equal(firstCalls, 2, 'a quota resets, so the preferred provider keeps being offered the work');
});

// Twenty-four exceptions in a row must not report "no provider configured" when
// the real cause was stated once, on the first one, and then forgotten.
test('a dropped provider keeps reporting why it was dropped', async () => {
  const legs = [
    { name: 'anthropic', model: 'claude-opus-5', client: { messages: { create: async () => {
      throw Object.assign(new Error('Your credit balance is too low'), { status: 400 });
    } } } },
  ];
  const chain = getClient({ clients: legs });
  const messages = [];
  for (let i = 0; i < 3; i++) {
    await chain.messages.create({ messages: [] }).catch((err) => messages.push(err.message));
  }
  assert.equal(messages.length, 3);
  for (const m of messages) assert.match(m, /credit balance/, 'every call must still name the real cause');
  assert.match(messages[2], /dropped earlier in this run/);
});

test('when everything fails the error names every provider that was tried', async () => {
  const legs = [
    { name: 'gemini', model: 'g', client: { messages: { create: async () => { throw Object.assign(new Error('key invalid'), { status: 401 }); } } } },
    { name: 'groq', model: 'l', client: { messages: { create: async () => { throw Object.assign(new Error('key invalid'), { status: 401 }); } } } },
  ];
  const chain = getClient({ clients: legs });
  await assert.rejects(() => chain.messages.create({ messages: [] }), (err) => {
    assert.match(err.message, /gemini/);
    assert.match(err.message, /groq/);
    assert.equal(err.failures.length, 2);
    return true;
  });
});

test('with no key at all there is no client, which every caller reads as "use the template"', () => {
  assert.equal(getClient({ env: {} }), null);
  assert.deepEqual(availableProviders({}), []);
  assert.match(describeProviders({}), /deterministic templates/);
});

test('the preference order is best-first, and LLM_PROVIDER promotes without excluding', () => {
  const env = { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' };
  assert.deepEqual(availableProviders(env).map((p) => p.name), ['anthropic', 'gemini', 'groq']);
  // Pinning chooses who answers first; the others stay behind it as fallbacks.
  assert.deepEqual(availableProviders({ ...env, LLM_PROVIDER: 'groq' }).map((p) => p.name), ['groq', 'anthropic', 'gemini']);
  assert.deepEqual(availableProviders({ GOOGLE_API_KEY: 'g' }).map((p) => p.name), ['gemini']);
  assert.match(describeProviders(env), /-> template$/);
});

// ---------------------------------------------------------------------------
// The whole thing, through a real caller
// ---------------------------------------------------------------------------

// The adapters being individually well-shaped proves nothing about whether the
// ask agent's hand-written tool loop actually drives one. This runs the real loop
// — real tools, real reconciliation — with only the network replaced.
test('the ask agent completes a full tool loop through the Gemini adapter', async () => {
  const dataset = materialize(generateDataset({ seed: 991, profile: 'standard' }), 'memory/llm-test');
  const result = { ...reconcile(dataset), dataset: { dir: 'memory/llm-test' } };
  const audit = result.audit.map((e, i) => ({ run_id: 'test', seq: i, ...e }));

  let turn = 0;
  const fetchImpl = async (url, init) => {
    turn++;
    const sent = JSON.parse(init.body);
    if (turn === 1) {
      // First turn: ask for a tool.
      return { ok: true, status: 200, json: async () => ({
        candidates: [{ content: { parts: [{ functionCall: { name: 'reconciliation_summary', args: {} } }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }) };
    }
    // Second turn: the tool output must have come back as a functionResponse.
    const parts = sent.contents.flatMap((c) => c.parts);
    const responded = parts.find((p) => p.functionResponse);
    assert.ok(responded, 'the tool result never reached the model');
    assert.equal(responded.functionResponse.name, 'reconciliation_summary');
    assert.ok('matched' in responded.functionResponse.response || 'total_invoices' in responded.functionResponse.response
      || Object.keys(responded.functionResponse.response).length > 0, 'the summary arrived empty');
    return { ok: true, status: 200, json: async () => ({
      candidates: [{ content: { parts: [{ text: 'Most of the month reconciled.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6 },
    }) };
  };

  const client = geminiClient({ apiKey: 'k', model: 'gemini-test', fetchImpl });
  const answer = await ask('how did the month go?', { result, audit, client });

  assert.equal(answer.answer, 'Most of the month reconciled.');
  assert.equal(answer.iterations, 2);
  assert.equal(answer.trace.length, 1, 'the trace must still record what was read');
  assert.equal(answer.trace[0].tool, 'reconciliation_summary');
  assert.equal(answer.usage.input_tokens, 30, 'usage accumulates across both turns');
});
