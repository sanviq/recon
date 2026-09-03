// What a run actually costs.
//
// A finance tool that costs more than the person it replaces is a demo, not a
// product, and "we used AI" is not an argument until someone has divided the bill
// by the number of exceptions. Every figure here comes from token counts the API
// actually reported for this run — nothing is estimated, and when a run went
// through the deterministic templates the cost is genuinely zero.

/**
 * Published list prices per million tokens, USD. Cache reads bill at a tenth of
 * the base input rate and cache writes at a premium over it, which is why the
 * explainer bothers to share one cached prefix across the whole batch.
 *
 * These are list rates at the time of writing; check the pricing page before
 * quoting them anywhere that matters.
 */
export const PRICING = {
  'claude-opus-5': { input: 5.00, output: 25.00, cache_read: 0.50, cache_write: 6.25 },
};

/**
 * A finance associate reconciling by hand. Deliberately conservative: 90 seconds
 * per exception assumes they already have all three systems open and know what
 * they are looking at, which is not usually true on the first pass.
 */
export const HUMAN = { secondsPerException: 90, hourlyUSD: 6 };

export function priceRun(usage, model = 'claude-opus-5') {
  const rate = PRICING[model];
  if (!rate || !usage) return null;
  const per = (tokens, usdPerMillion) => (tokens ?? 0) * usdPerMillion / 1_000_000;
  const usd =
    per(usage.input, rate.input) +
    per(usage.output, rate.output) +
    per(usage.cache_read, rate.cache_read) +
    per(usage.cache_write, rate.cache_write);

  return {
    model,
    usd: Number(usd.toFixed(6)),
    tokens: {
      input: usage.input ?? 0, output: usage.output ?? 0,
      cache_read: usage.cache_read ?? 0, cache_write: usage.cache_write ?? 0,
    },
    // What the shared cached prefix actually bought. Without it every request in
    // the batch would have paid the full input rate for the same system prompt.
    cache_saved_usd: Number((per(usage.cache_read, rate.input - rate.cache_read)).toFixed(6)),
  };
}

/** The comparison that makes the number mean something. */
export function comparedToHuman(exceptionCount, elapsedMs, cost) {
  const humanSeconds = exceptionCount * HUMAN.secondsPerException;
  return {
    exceptions: exceptionCount,
    machine_seconds: Number((elapsedMs / 1000).toFixed(1)),
    human_seconds: humanSeconds,
    human_usd: Number((humanSeconds / 3600 * HUMAN.hourlyUSD).toFixed(2)),
    machine_usd: cost?.usd ?? 0,
    usd_per_exception: exceptionCount ? Number(((cost?.usd ?? 0) / exceptionCount).toFixed(6)) : 0,
    speedup: elapsedMs ? Math.round(humanSeconds / (elapsedMs / 1000)) : null,
  };
}

export function formatCostLine(economics, cost) {
  if (!cost || !cost.usd) {
    return `  cost: $0.00 — every note came from the deterministic templates, which need no API call`;
  }
  const lines = [
    `  cost: $${cost.usd.toFixed(4)} for ${economics.exceptions} exception(s) — $${economics.usd_per_exception.toFixed(5)} each`,
    `  the same review by hand: ~${(economics.human_seconds / 60).toFixed(0)} minutes, about $${economics.human_usd.toFixed(2)} of analyst time`,
  ];
  if (economics.speedup) lines.push(`  ${economics.speedup}x faster, and it never gets bored on row 40`);
  if (cost.cache_saved_usd > 0) lines.push(`  prompt caching saved $${cost.cache_saved_usd.toFixed(4)} on this batch alone`);
  return lines.join('\n');
}
