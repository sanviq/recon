// Normalisation layer. Three sources, three vocabularies, one internal shape.
//
// Everything downstream sees the same field names and integer paise, so the
// matching engine never has to know whether a record came from a CSV export, a
// bank download, or the Razorpay API. Swapping the fixture loader for the live
// API client changes nothing below this file.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCSV } from '../lib/csv.js';
import { toPaise } from '../lib/money.js';
import { unixToISODate } from '../lib/dates.js';

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * Loads one dataset directory into normalised records.
 * Tolerates missing truth.json — live-pulled data has no ground truth, and that
 * is exactly the difference between the demo run and the scored run.
 */
export function loadDataset(dir) {
  const at = (name) => resolve(dir, name);
  const ledgerRows = parseCSV(readFileSync(at('ledger.csv'), 'utf8'));
  const bankRows = parseCSV(readFileSync(at('bank_statement.csv'), 'utf8'));
  const reconRows = readJSON(at('recon_report.json'));
  const payments = existsSync(at('payments.json')) ? readJSON(at('payments.json')) : [];
  const settlements = existsSync(at('settlements.json')) ? readJSON(at('settlements.json')) : [];
  const truth = existsSync(at('truth.json')) ? readJSON(at('truth.json')) : null;
  const manifest = existsSync(at('manifest.json')) ? readJSON(at('manifest.json')) : {};

  return {
    dir,
    manifest,
    truth,
    ledger: normaliseLedger(ledgerRows),
    bank: normaliseBank(bankRows),
    payments: normalisePayments(reconRows, payments, settlements),
    settlements,
  };
}

export function normaliseLedger(rows) {
  return rows.map((r, i) => ({
    row_index: i,
    invoice_id: r.invoice_id || `LEDGER-${i}`,
    order_ref: (r.order_ref || '').trim(),
    customer: r.customer || '',
    date: r.invoice_date,
    amount: toPaise(r.amount),
    currency: r.currency || 'INR',
    raw: r,
  }));
}

export function normaliseBank(rows) {
  return rows
    // Reconciliation of inbound settlement money only cares about credits. Debits
    // (refunds, chargebacks, the merchant's own spending) are a different loop.
    .map((r, i) => ({
      row_index: i,
      txn_id: r.txn_id || `BANK-${i}`,
      date: r.value_date,
      utr: extractUTR(r),
      credit: toPaise(r.credit || 0),
      debit: toPaise(r.debit || 0),
      description: r.description || '',
      raw: r,
    }))
    .filter((r) => r.credit > 0);
}

/**
 * The UTR is the join key between Razorpay and the bank. Real statements often
 * do not have a UTR column at all — it is buried in the narration string — so we
 * take the column when it exists and fall back to digging it out of the
 * description. Getting this wrong silently destroys the entire bank leg.
 */
export function extractUTR(row) {
  const direct = (row.utr || row.UTR || row.reference || '').trim();
  if (direct) return direct;
  const m = (row.description || '').match(/\b([A-Z]{4}[A-Z0-9]{6,18})\b/);
  return m ? m[1] : '';
}

/**
 * Razorpay's settlement recon report is the authoritative source for
 * "which payment was paid out under which UTR". Where it is available we prefer
 * it; the Payments API alone cannot tell you that, because a payment does not
 * know its own settlement.
 */
export function normalisePayments(reconRows, payments, settlements) {
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  const settlementById = new Map(settlements.map((s) => [s.id, s]));

  return reconRows
    .filter((r) => r.type === 'payment')
    .map((r, i) => {
      const p = paymentById.get(r.payment_id ?? r.entity_id);
      const s = settlementById.get(r.settlement_id);
      const amount = r.amount ?? p?.amount ?? 0;
      const fee = r.fee ?? p?.fee ?? 0;
      const tax = r.tax ?? p?.tax ?? 0;
      return {
        row_index: i,
        id: r.payment_id ?? r.entity_id,
        order_id: r.order_id ?? p?.order_id ?? null,
        // Merchants stuff their own invoice number into notes. When it is there
        // it is the strongest join key available; when it is not, we fall back
        // to amount and date.
        invoice_ref: r.notes?.invoice_ref ?? p?.notes?.invoice_ref ?? null,
        customer: r.notes?.customer ?? p?.notes?.customer ?? '',
        amount,
        fee,
        tax,
        // Never trust a reported net. Recompute it, so a fee the gateway reports
        // differently from what it charged shows up as a real discrepancy.
        net: r.credit ?? amount - fee - tax,
        date: p?.captured_date ?? unixToISODate(r.created_at),
        settlement_id: r.settlement_id ?? null,
        utr: r.settlement_utr ?? s?.utr ?? null,
        settled_date: s?.settled_date ?? (r.settled_at ? unixToISODate(r.settled_at) : null),
        settled: r.settled !== false,
        raw: r,
      };
    });
}
