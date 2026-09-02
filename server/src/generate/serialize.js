// One place that knows how a generated dataset becomes the on-disk file formats.
//
// Shared by the generate CLI (which writes them) and the sweep (which round-trips
// them in memory). The sweep must go through exactly the same CSV serialisation
// and parsing as a real run, otherwise it would be scoring a pipeline the demo
// never actually executes.

import { toCSV, parseCSV } from '../lib/csv.js';
import { paiseToDecimal } from '../lib/money.js';
import { normaliseLedger, normaliseBank, normalisePayments } from '../sources/load.js';

const LEDGER_COLS = ['invoice_id', 'order_ref', 'customer', 'invoice_date', 'amount', 'currency', 'status'];
const BANK_COLS = ['txn_id', 'value_date', 'description', 'utr', 'credit', 'debit', 'balance'];

/** Internal ground-truth bookkeeping fields never reach the engine. */
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));

export function ledgerCSV(ledger) {
  return toCSV(ledger.map((r) => ({ ...r, amount: paiseToDecimal(r.amount) })), LEDGER_COLS);
}

export function bankCSV(bank) {
  return toCSV(
    bank.map((r) => ({
      ...strip(r),
      credit: paiseToDecimal(r.credit),
      debit: paiseToDecimal(r.debit),
      balance: paiseToDecimal(r.balance),
    })),
    BANK_COLS,
  );
}

export function serializeDataset(ds) {
  return {
    'ledger.csv': ledgerCSV(ds.ledger),
    'bank_statement.csv': bankCSV(ds.bank),
    'payments.json': JSON.stringify(ds.payments.map(strip), null, 2),
    'settlements.json': JSON.stringify(ds.settlements, null, 2),
    'recon_report.json': JSON.stringify(ds.reconRows, null, 2),
    'truth.json': JSON.stringify(ds.truth, null, 2),
    'manifest.json': JSON.stringify({ ...ds.manifest, source: 'synthetic' }, null, 2),
  };
}

/**
 * Generated dataset -> the exact shape loadDataset() would return, without
 * touching the filesystem. Same serialisation, same parsers, same normalisation.
 */
export function materialize(ds, dir = 'memory') {
  const files = serializeDataset(ds);
  return {
    dir,
    manifest: ds.manifest,
    truth: ds.truth,
    ledger: normaliseLedger(parseCSV(files['ledger.csv'])),
    bank: normaliseBank(parseCSV(files['bank_statement.csv'])),
    payments: normalisePayments(ds.reconRows, JSON.parse(files['payments.json']), ds.settlements),
    settlements: ds.settlements,
  };
}
