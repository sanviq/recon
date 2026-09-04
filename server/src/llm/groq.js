// Groq, wearing the Anthropic Messages shape.
//
// Groq speaks the OpenAI chat-completions dialect, which differs from Anthropic's
// in three ways that matter here: tool calls arrive as a sibling field rather than
// as content blocks, tool results are their own message role instead of blocks
// inside a user turn, and JSON mode is a flag rather than a schema.
//
// It exists alongside the Gemini adapter as the second leg of the fallback chain.
// A free tier is a rate limit with a friendly name, and the one thing that must
// not happen is a live demo dying because a per-minute quota was reached.

const ENDPOINT = 'https://api.groq.com/openai/v1';

export const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

function systemText(system) {
  if (!system) return null;
  if (typeof system === 'string') return system;
  return system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n') || null;
}

export function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });

  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const text = (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const toolCalls = (message.content ?? [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));

      const turn = { role: 'assistant', content: text || null };
      if (toolCalls.length) turn.tool_calls = toolCalls;
      out.push(turn);
      continue;
    }

    // A user turn is either prose or a bundle of tool results. Results become
    // one `tool` message each — OpenAI has no notion of several inside one turn.
    const results = (message.content ?? []).filter((b) => b.type === 'tool_result');
    if (results.length) {
      for (const r of results) {
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: String(r.content) });
      }
    }
    const text = (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (text) out.push({ role: 'user', content: text });
  }

  return out;
}

export function fromOpenAIResponse(body, model) {
  const choice = body?.choices?.[0];
  const message = choice?.message ?? {};
  const content = [];

  if (message.content) content.push({ type: 'text', text: message.content });

  for (const call of message.tool_calls ?? []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || '{}');
    } catch {
      // A model that emits unparseable arguments gets an empty object rather than
      // a thrown error; the tool layer already validates its own inputs.
      input = {};
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
  }

  const finish = choice?.finish_reason;
  let stop_reason = 'end_turn';
  if (message.tool_calls?.length) stop_reason = 'tool_use';
  else if (finish === 'length') stop_reason = 'max_tokens';
  else if (finish === 'content_filter') stop_reason = 'refusal';

  const usage = body?.usage ?? {};
  return {
    model,
    content,
    stop_reason,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

async function describeUnknownModel(apiKey, model, fetchImpl) {
  try {
    const res = await fetchImpl(`${ENDPOINT}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
    const body = await res.json();
    const usable = (body.data ?? []).map((m) => m.id).slice(0, 8);
    if (usable.length) return `Groq has no model "${model}". Set GROQ_MODEL in .env to one of: ${usable.join(', ')}`;
  } catch {
    // The original failure is the useful part; the listing is a courtesy.
  }
  return `Groq has no model "${model}". Set GROQ_MODEL in .env to a model your key can use.`;
}

export function groqClient({ apiKey, model = DEFAULT_GROQ_MODEL, fetchImpl = fetch } = {}) {
  const create = async (req) => {
    let system = systemText(req.system);
    const format = req.output_config?.format;

    // Groq's JSON mode guarantees syntactically valid JSON but not the shape.
    // The schema is therefore restated in the system prompt: json_object keeps
    // the parse from failing, and the instruction keeps the fields right.
    if (format?.type === 'json_schema' && format.schema) {
      system = `${system ?? ''}\n\nRespond with a single JSON object and nothing else. It must match this schema exactly:\n${JSON.stringify(format.schema)}`.trim();
    }

    const body = {
      model,
      messages: toOpenAIMessages(req.messages ?? [], system),
      max_tokens: req.max_tokens ?? 4096,
      temperature: 0,
    };

    if (format?.type === 'json_schema' && !req.tools?.length) {
      body.response_format = { type: 'json_object' };
    }

    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object', properties: {} } },
      }));
    }

    const res = await fetchImpl(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const message = res.status === 404
        ? await describeUnknownModel(apiKey, model, fetchImpl)
        : `Groq returned ${res.status}: ${detail.slice(0, 400)}`;
      throw Object.assign(new Error(message), { status: res.status, provider: 'groq' });
    }

    return fromOpenAIResponse(await res.json(), model);
  };

  return { provider: 'groq', model, messages: { create } };
}
