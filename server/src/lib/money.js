// All money in Recon is an integer count of paise. Never a float.
//
// Why: reconciliation is an equality test on money. Floats make equality a lie
// (0.1 + 0.2 !== 0.3), so a float pipeline invents amount mismatches that do not
// exist and hides real ones inside rounding noise. Razorpay's own API already
// speaks paise, so this is also the native unit — the only place we leave it is
// the display layer.

export const RUPEE = 100;

/** Parse a rupee string/number from a CSV into integer paise. */
export function toPaise(rupees) {
  if (typeof rupees === 'number') return Math.round(rupees * RUPEE);
  const cleaned = String(rupees).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-') throw new Error(`not an amount: ${rupees}`);
  return Math.round(Number(cleaned) * RUPEE);
}

/** Format paise for humans: 123456 -> "1,234.56" */
export function formatPaise(paise) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / RUPEE);
  const fraction = String(abs % RUPEE).padStart(2, '0');
  return `${sign}${rupees.toLocaleString('en-IN')}.${fraction}`;
}

/** Rupee-decimal string for CSV output: 123456 -> "1234.56" */
export function paiseToDecimal(paise) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / RUPEE)}.${String(abs % RUPEE).padStart(2, '0')}`;
}

/**
 * Razorpay's standard domestic pricing, applied the way the real API reports it:
 * a percentage fee on the gross amount, then 18% GST on that fee. The merchant
 * is credited amount - fee - tax, so the number that lands in the bank never
 * equals the number on the invoice. Getting this wrong is the single most common
 * cause of a false "amount mismatch" in hand-rolled reconciliation.
 */
export function razorpayFees(amountPaise, { rateBps = 200, gstBps = 1800 } = {}) {
  const fee = Math.round((amountPaise * rateBps) / 10_000);
  const tax = Math.round((fee * gstBps) / 10_000);
  return { fee, tax, net: amountPaise - fee - tax };
}
