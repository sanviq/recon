// Dates are handled as plain YYYY-MM-DD strings in UTC. Settlement lag is counted
// in whole days, so timezone-aware datetimes would only add drift bugs.

const DAY_MS = 86_400_000;

export function toISODate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export function addDays(isoDate, days) {
  return toISODate(new Date(`${isoDate}T00:00:00Z`).getTime() + days * DAY_MS);
}

/** Signed whole-day difference: later - earlier. */
export function daysBetween(earlierISO, laterISO) {
  const a = new Date(`${earlierISO}T00:00:00Z`).getTime();
  const b = new Date(`${laterISO}T00:00:00Z`).getTime();
  return Math.round((b - a) / DAY_MS);
}

export function unixToISODate(seconds) {
  return toISODate(seconds * 1000);
}

export function isoToUnix(isoDate) {
  return Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);
}
