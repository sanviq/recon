// Turning what a bank actually prints into what the engine can compare.
//
// Column names are only half the problem. The other half is that "05/08/2026"
// is the 5th of August in Mumbai and the 8th of May in New York, and the whole
// settlement-window logic is built on day arithmetic. A date read the wrong way
// round does not throw — it silently shifts every credit by up to eleven days and
// turns correct matches into date_out_of_window exceptions.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MMM-YYYY'];

const pad = (n) => String(n).padStart(2, '0');
const fourDigitYear = (y) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

/**
 * Reads a date under a declared format. Returns null rather than a wrong date —
 * a null surfaces as a load error, a wrong date surfaces as a wrong reconciliation.
 */
export function parseDate(value, format = 'YYYY-MM-DD') {
  const s = String(value ?? '').trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${pad(+iso[2])}-${pad(+iso[3])}`;

  const named = s.match(/^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{2,4})/);
  if (named) {
    const m = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (!m) return null;
    return `${fourDigitYear(+named[3])}-${pad(m)}-${pad(+named[1])}`;
  }

  const numeric = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (numeric) {
    const [, a, b, y] = numeric;
    const [day, month] = format === 'MM/DD/YYYY' ? [+b, +a] : [+a, +b];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${fourDigitYear(+y)}-${pad(month)}-${pad(day)}`;
  }

  return null;
}

/**
 * Infers the date format from a whole column instead of one cell.
 *
 * A single "05/08/2026" is genuinely ambiguous. A column of them usually is not:
 * one value with a first component above 12 proves day-first, one with a second
 * component above 12 proves month-first. When the column proves nothing, we say
 * so — `ambiguous` is what makes the model's opinion worth asking for, and what
 * gets shown to the user when there is no model.
 */
export function inferDateFormat(samples) {
  const vals = samples.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!vals.length) return { format: 'YYYY-MM-DD', ambiguous: false, evidence: 'no values' };
  if (vals.every((v) => /^\d{4}-\d{1,2}-\d{1,2}/.test(v))) {
    return { format: 'YYYY-MM-DD', ambiguous: false, evidence: 'ISO 8601 in every row' };
  }
  if (vals.every((v) => /^\d{1,2}[-/\s][A-Za-z]{3}/.test(v))) {
    return { format: 'DD-MMM-YYYY', ambiguous: false, evidence: 'month is spelled, so the order is unambiguous' };
  }

  let firstOver12 = false;
  let secondOver12 = false;
  for (const v of vals) {
    const m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.]/);
    if (!m) continue;
    if (+m[1] > 12) firstOver12 = true;
    if (+m[2] > 12) secondOver12 = true;
  }
  if (firstOver12 && !secondOver12) return { format: 'DD/MM/YYYY', ambiguous: false, evidence: 'a first component above 12 proves day-first' };
  if (secondOver12 && !firstOver12) return { format: 'MM/DD/YYYY', ambiguous: false, evidence: 'a second component above 12 proves month-first' };
  if (firstOver12 && secondOver12) return { format: 'YYYY-MM-DD', ambiguous: true, evidence: 'both components exceed 12 somewhere — the column is not internally consistent' };
  return { format: 'DD/MM/YYYY', ambiguous: true, evidence: 'every component is 12 or below, so the column cannot prove its own order; defaulted to day-first' };
}

/**
 * Rupee text to a rupee-decimal string, ready for toPaise.
 * Handles Indian grouping, currency symbols, a trailing Cr/Dr, and accounting
 * parentheses — which mean negative, and which toPaise would otherwise strip
 * into a positive number.
 */
export function cleanAmount(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '-' || raw === '—') return '0';
  const negative = /^\(.*\)$/.test(raw) || /^-/.test(raw) || /\bdr\b/i.test(raw);
  const digits = raw.replace(/[^0-9.]/g, '');
  if (!digits || Number.isNaN(Number(digits))) return '0';
  return `${negative ? '-' : ''}${digits}`;
}

/** Does a Cr/Dr indicator mean money in? */
export const isCreditIndicator = (value) => /^(c|cr|credit|deposit|in)$/i.test(String(value ?? '').trim());

/**
 * Rewrites parsed rows into canonical columns using a resolved mapping.
 * A single amount column plus a direction indicator is split into credit/debit
 * here, so everything downstream only ever sees the two-column form.
 */
export function applyMapping(rows, mapping, kind, { dateFormat = 'YYYY-MM-DD' } = {}) {
  const col = (f) => mapping[f]?.source_column ?? null;
  const get = (row, f) => (col(f) ? row[col(f)] : undefined);

  return rows.map((row, i) => {
    const out = {};

    if (kind === 'bank') {
      out.txn_id = String(get(row, 'txn_id') ?? `BANK-${i}`).trim();
      out.value_date = parseDate(get(row, 'value_date'), dateFormat) ?? '';
      out.description = String(get(row, 'description') ?? '').trim();
      out.utr = String(get(row, 'utr') ?? '').trim();

      if (col('credit') || col('debit')) {
        out.credit = cleanAmount(get(row, 'credit'));
        out.debit = cleanAmount(get(row, 'debit'));
      } else if (col('amount')) {
        // One amount column: the indicator decides the side. Without an
        // indicator, sign is the only evidence available.
        const amount = cleanAmount(get(row, 'amount'));
        const indicator = col('txn_type') ? get(row, 'txn_type') : null;
        const inbound = indicator !== null ? isCreditIndicator(indicator) : !amount.startsWith('-');
        const magnitude = amount.replace(/^-/, '');
        out.credit = inbound ? magnitude : '0';
        out.debit = inbound ? '0' : magnitude;
      } else {
        out.credit = '0';
        out.debit = '0';
      }
      return out;
    }

    out.invoice_id = String(get(row, 'invoice_id') ?? `LEDGER-${i}`).trim();
    out.order_ref = String(get(row, 'order_ref') ?? '').trim();
    out.customer = String(get(row, 'customer') ?? '').trim();
    out.invoice_date = parseDate(get(row, 'invoice_date'), dateFormat) ?? '';
    out.amount = cleanAmount(get(row, 'amount'));
    out.currency = String(get(row, 'currency') ?? 'INR').trim() || 'INR';
    return out;
  });
}
