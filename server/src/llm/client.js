// Which model provider answers, and what happens when one stops answering.
//
// The project is built to run on free tiers. A free tier is a rate limit with a
// friendly name, and the failure it produces — a 429 halfway through a batch, or
// a 402 the morning of a demo — is not an edge case. So provider choice is a
// chain rather than a setting: the first configured provider answers, and if it
// refuses in a way that will not fix itself, it is dropped for the rest of the
// process and the next one takes over. Below all of them sits the deterministic
// template path, which needs no key at all and never fails.
//
// Everything above this file still calls `client.messages.create(...)` and reads
// `content` / `stop_reason` / `usage`. That contract is why this was a small
// change: it was already the seam the tests injected fakes through.

import Anthropic from '@anthropic-ai/sdk';
import { geminiClient, DEFAULT_GEMINI_MODEL } from './gemini.js';
import { groqClient, DEFAULT_GROQ_MODEL } from './groq.js';

export const ANTHROPIC_MODEL = 'claude-opus-5';

// Ordered best-first. Anthropic leads when it is funded; the free tiers behind it
// are what make the project runnable by someone who has not paid for anything.
const REGISTRY = [
  {
    name: 'anthropic',
    env: 'ANTHROPIC_API_KEY',
    model: () => process.env.ANTHROPIC_MODEL || ANTHROPIC_MODEL,
    make: (model) => {
      const sdk = new Anthropic();
      return { provider: 'anthropic', model, messages: { create: (req) => sdk.messages.create({ ...req, model }) } };
    },
  },
  {
    name: 'gemini',
    env: 'GEMINI_API_KEY',
    altEnv: 'GOOGLE_API_KEY',
    model: () => DEFAULT_GEMINI_MODEL,
    make: (model) => geminiClient({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, model }),
  },
  {
    name: 'groq',
    env: 'GROQ_API_KEY',
    model: () => DEFAULT_GROQ_MODEL,
    make: (model) => groqClient({ apiKey: process.env.GROQ_API_KEY, model }),
  },
];

/** The providers this machine is actually configured for, in preference order. */
export function availableProviders(env = process.env) {
  const pinned = env.LLM_PROVIDER?.trim().toLowerCase();
  const configured = REGISTRY.filter((e) => (env[e.env] || (e.altEnv && env[e.altEnv])));
  if (!pinned) return configured;
  // Pinning is an override for the demo, not a filter: if the named provider is
  // configured it goes first, and the rest stay behind it as fallbacks.
  const named = configured.filter((e) => e.name === pinned);
  return [...named, ...configured.filter((e) => e.name !== pinned)];
}

export function hasProvider(env = process.env) {
  return availableProviders(env).length > 0;
}

// Free tiers meter by requests per minute, so firing a whole batch at once buys
// nothing but 429s and the waiting that follows them. The paid path has no such
// cap and keeps the wider pool.
const FREE_TIER = new Set(['gemini', 'groq']);

export function suggestedConcurrency(env = process.env) {
  const list = availableProviders(env);
  if (!list.length) return 4;
  return FREE_TIER.has(list[0].name) ? 2 : 4;
}

/**
 * How many times to wait out a rate limit before giving up on a provider.
 *
 * A free tier meters per minute, so the wait that clears it is measured in tens
 * of seconds. Three attempts buys about seven seconds of backoff — not enough to
 * outlast the window, which is why a batch of two dozen exceptions was sending
 * most of its notes to the template even though the key was working. Six
 * attempts covers the minute. On a paid tier a 429 means something else and
 * waiting a minute for it is not worth the latency.
 */
export function suggestedRetries(env = process.env) {
  const list = availableProviders(env);
  return list.length && FREE_TIER.has(list[0].name) ? 7 : 3;
}

/** A one-line description for the CLIs, so a run says who wrote its prose. */
export function describeProviders(env = process.env) {
  const list = availableProviders(env);
  if (!list.length) return 'deterministic templates (no model key set)';
  return list.map((e) => `${e.name}:${e.model()}`).join(' -> ') + ' -> template';
}

/**
 * Reads a JSON object out of a model's reply.
 *
 * Anthropic with a json_schema format returns bare JSON. The free models are less
 * disciplined — an open-weights model in JSON mode still wraps its answer in a
 * ```json fence often enough to matter, and one stray fence would send an
 * otherwise perfect note to the template. The fence is stripped, and failing that
 * the outermost braces are taken.
 */
export function parseModelJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('the model returned nothing');

  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to the tolerant paths below.
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Still not valid — try the brace scan.
    }
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) return JSON.parse(raw.slice(start, end + 1));

  throw new Error(`the model did not return JSON: ${raw.slice(0, 120)}`);
}

/**
 * A refusal that will not fix itself on a retry. A missing key, an unfunded
 * account or an unknown model is permanent for this process; a rate limit is not,
 * so 429 deliberately does not appear here.
 */
export function isPermanentFailure(err) {
  const status = err?.status ?? err?.statusCode;
  if ([400, 401, 402, 403, 404].includes(status)) {
    // A 400 is only permanent when it is about money or entitlement. A malformed
    // request for one record should not disable the provider for the other 23.
    if (status === 400) return /credit balance|billing|quota|not found|permission|api key/i.test(String(err?.message ?? ''));
    return true;
  }
  return /credit balance|insufficient|billing|expired|invalid api key|api key not valid/i.test(String(err?.message ?? ''));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait before offering a rate-limited provider the same request again.
 *
 * Free tiers are measured in requests per minute, and a batch of two dozen
 * exceptions will exceed one. Falling straight through to the next provider on a
 * 429 would work, but it spends the second provider's quota on the first one's
 * traffic and leaves nothing in reserve — so the same provider is given a few
 * chances first, honouring whatever delay it asked for.
 */
export function backoffMs(err, attempt) {
  const asked = err?.retryAfterMs;
  if (Number.isFinite(asked) && asked > 0) return Math.min(asked, 30_000);
  // Capped at 15s rather than 8s: a per-minute quota that has just been exhausted
  // is not going to clear in eight seconds, and the backoff should be able to sit
  // out most of a window without needing an unreasonable number of attempts.
  return Math.min(1000 * 2 ** attempt, 15_000);
}

/**
 * Builds the chain. Returns null when nothing is configured, which every caller
 * already reads as "use the template".
 */
export function getClient({ env = process.env, clients = null, maxRetries = suggestedRetries(env), sleep = defaultSleep } = {}) {
  const legs = clients ?? availableProviders(env).map((entry) => {
    let built = null;
    return {
      name: entry.name,
      model: entry.model(),
      // Constructed on first use so an unused provider's SDK never validates a key.
      get client() {
        built ??= entry.make(entry.model());
        return built;
      },
    };
  });

  if (!legs.length) return null;

  // Why each dropped provider was dropped, not merely that it was. Twenty-four
  // exceptions in a row reporting "no provider configured" would send someone
  // looking for a missing key when the real answer was an unfunded account, and
  // only the first of the twenty-four would have said so.
  const disabled = new Map();

  const chain = {
    provider: legs[0].name,
    model: legs[0].model,
    providers: legs.map((l) => `${l.name}:${l.model}`),
    used: [],
    // How often a free tier made us wait. Worth surfacing: it is the difference
    // between "the run was slow" and "the run was slow for a reason".
    throttled: 0,
    messages: {
      create: async (req) => {
        const failures = [];
        let last = null;

        for (const leg of legs) {
          if (disabled.has(leg.name)) {
            failures.push(`${leg.name}: ${disabled.get(leg.name)} (dropped earlier in this run)`);
            continue;
          }
          for (let attempt = 0; ; attempt++) {
            try {
              const response = await leg.client.messages.create(req);
              chain.provider = leg.name;
              chain.model = response.model ?? leg.model;
              if (!chain.used.includes(leg.name)) chain.used.push(leg.name);
              return response;
            } catch (err) {
              err.provider ??= leg.name;
              const rateLimited = (err?.status ?? err?.statusCode) === 429 || /rate.?limit|RESOURCE_EXHAUSTED|quota/i.test(String(err?.message ?? ''));
              if (rateLimited && attempt < maxRetries) {
                chain.throttled++;
                await sleep(backoffMs(err, attempt));
                continue;
              }
              if (isPermanentFailure(err)) disabled.set(leg.name, err.message ?? String(err));
              failures.push(`${leg.name}: ${err?.message ?? err}`);
              last = err;
              break;
            }
          }
        }

        throw Object.assign(new Error(failures.join(' | ') || 'no model provider is configured'), {
          status: last?.status ?? last?.statusCode ?? 503,
          provider: last?.provider,
          failures,
        });
      },
    },
  };

  return chain;
}
