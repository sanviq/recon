// Google Gemini, wearing the Anthropic Messages shape.
//
// Every model call site in this project already took an injected client, because
// the tests needed to hand them fakes. That seam is the only reason a second
// provider is a small change rather than a rewrite: nothing above this file knows
// which company answered.
//
// The translation is not cosmetic. Gemini names things differently, refuses JSON
// Schema keywords Anthropic accepts, returns no id for a tool call, and reports
// a refusal as a finish reason rather than a stop reason. Each of those is
// handled here so the callers keep reading `response.content`, `stop_reason` and
// `usage` exactly as before.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Overridable, because a free-tier model name is a moving target and a wrong one
// should be a one-line .env fix rather than a code change.
export const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Gemini validates against an OpenAPI subset, not JSON Schema. `additionalProperties`
// — which every strict Anthropic schema in this repo sets — is a hard 400 here, so
// the schema is rebuilt from a whitelist rather than patched key by key.
const ALLOWED = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'format', 'minimum', 'maximum']);

export function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'items') {
      out.items = toGeminiSchema(value);
    } else if (key === 'type' && Array.isArray(value)) {
      // JSON Schema writes an optional string as ['string','null']; Gemini wants
      // one type and a nullable flag.
      out.type = value.find((t) => t !== 'null') ?? 'string';
      if (value.includes('null')) out.nullable = true;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Anthropic sends system as blocks (so they can carry cache_control); Gemini wants one string. */
function systemText(system) {
  if (!system) return null;
  if (typeof system === 'string') return system;
  return system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n') || null;
}

/**
 * Gemini's functionResponse is keyed by tool NAME, but a tool_result block only
 * carries the tool_use_id. The name is recoverable from the assistant turn that
 * requested it, so the whole transcript is indexed before any of it is converted.
 */
function indexToolNames(messages) {
  const byId = new Map();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block?.type === 'tool_use') byId.set(block.id, block.name);
    }
  }
  return byId;
}

export function toGeminiContents(messages) {
  const names = indexToolNames(messages);
  const contents = [];

  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';

    if (typeof message.content === 'string') {
      contents.push({ role, parts: [{ text: message.content }] });
      continue;
    }

    const parts = [];
    for (const block of message.content ?? []) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({ functionCall: { name: block.name, args: block.input ?? {} } });
      } else if (block.type === 'tool_result') {
        let payload;
        try {
          payload = JSON.parse(block.content);
        } catch {
          payload = { result: String(block.content) };
        }
        parts.push({
          functionResponse: {
            name: names.get(block.tool_use_id) ?? 'tool',
            // Gemini requires an object here; a bare array or string is rejected.
            response: Array.isArray(payload) || typeof payload !== 'object' ? { result: payload } : payload,
          },
        });
      }
      // Thinking blocks are Anthropic-only and are simply dropped.
    }

    if (parts.length) contents.push({ role, parts });
  }

  return contents;
}

export function fromGeminiResponse(body, model) {
  const candidate = body?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content = [];
  let calls = 0;

  for (const part of parts) {
    if (typeof part.text === 'string' && part.text.length) {
      content.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      // Gemini issues no call id. One is minted here so the tool loop above can
      // pair a result back to its request the way it always has.
      content.push({
        type: 'tool_use',
        id: `gem_${calls++}_${part.functionCall.name}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      });
    }
  }

  const finish = candidate?.finishReason;
  let stop_reason = 'end_turn';
  if (calls) stop_reason = 'tool_use';
  else if (finish === 'MAX_TOKENS') stop_reason = 'max_tokens';
  else if (finish === 'SAFETY' || finish === 'RECITATION' || finish === 'BLOCKLIST' || finish === 'PROHIBITED_CONTENT') stop_reason = 'refusal';

  const usage = body?.usageMetadata ?? {};
  return {
    model,
    content,
    stop_reason,
    usage: {
      input_tokens: usage.promptTokenCount ?? 0,
      output_tokens: usage.candidatesTokenCount ?? 0,
      // Gemini bills implicit caching separately and does not report a write.
      cache_read_input_tokens: usage.cachedContentTokenCount ?? 0,
      cache_creation_input_tokens: 0,
    },
  };
}

/**
 * A model name is the one thing here most likely to go stale, and a bare 404 is
 * useless to someone who just wants their demo to run. On an unknown model the
 * account's actual model list is fetched and named in the error.
 */
async function describeUnknownModel(apiKey, model, fetchImpl) {
  try {
    const res = await fetchImpl(`${ENDPOINT}?key=${apiKey}`);
    const body = await res.json();
    const usable = (body.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''))
      .filter((n) => n.startsWith('gemini'))
      .slice(0, 8);
    if (usable.length) {
      return `Gemini has no model "${model}". Set GEMINI_MODEL in .env to one of: ${usable.join(', ')}`;
    }
  } catch {
    // Falls through to the plain message — the original failure is what matters.
  }
  return `Gemini has no model "${model}". Set GEMINI_MODEL in .env to a model your key can use.`;
}

export function geminiClient({ apiKey, model = DEFAULT_GEMINI_MODEL, fetchImpl = fetch } = {}) {
  const create = async (req) => {
    const contents = toGeminiContents(req.messages ?? []);
    const body = {
      contents,
      generationConfig: { maxOutputTokens: req.max_tokens ?? 4096, temperature: 0 },
    };

    const sys = systemText(req.system);
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };

    const format = req.output_config?.format;
    if (format?.type === 'json_schema' && format.schema) {
      body.generationConfig.responseMimeType = 'application/json';
      body.generationConfig.responseSchema = toGeminiSchema(format.schema);
    }

    if (req.tools?.length) {
      body.tools = [{
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiSchema(t.input_schema ?? { type: 'object', properties: {} }),
        })),
      }];
    }

    const res = await fetchImpl(`${ENDPOINT}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const message = res.status === 404
        ? await describeUnknownModel(apiKey, model, fetchImpl)
        : `Gemini returned ${res.status}: ${detail.slice(0, 400)}`;
      // Honour the wait the provider asked for rather than guessing at one.
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      throw Object.assign(new Error(message), {
        status: res.status,
        provider: 'gemini',
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      });
    }

    return fromGeminiResponse(await res.json(), model);
  };

  return { provider: 'gemini', model, messages: { create } };
}
