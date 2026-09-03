import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicMapping, missingRequired, isNative } from '../src/ingest/schema.js';
import { parseDate, inferDateFormat, cleanAmount, applyMapping } from '../src/ingest/values.js';
import { mapTable } from '../src/ingest/mapper.js';

// Real header rows. Every one of these is a file a merchant would actually hand
// over, and none of them uses our field names.
const HDFC = ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'];
const ICICI = ['S No.', 'Value Date', 'Transaction Date', 'Transaction Remarks', 'Withdrawal Amount (INR )', 'Deposit Amount (INR )', 'Balance (INR )'];
const AXIS = ['SRL NO', 'Tran Date', 'PARTICULARS', 'AMOUNT', 'DR|CR', 'BAL'];
const TALLY = ['Voucher No.', 'Date', 'Particulars', 'Debit', 'Credit'];

test('resolves an HDFC statement without a model', () => {
  const m = heuristicMapping(HDFC, 'bank');
  assert.equal(m.value_date.source_column, 'Value Dt');
  assert.equal(m.description.source_column, 'Narration');
  assert.equal(m.credit.source_column, 'Deposit Amt.');
  assert.equal(m.debit.source_column, 'Withdrawal Amt.');
  assert.deepEqual(missingRequired(m, 'bank'), []);
});

test('resolves an ICICI statement without a model', () => {
  const m = heuristicMapping(ICICI, 'bank');
  assert.equal(m.credit.source_column, 'Deposit Amount (INR )');
  assert.equal(m.description.source_column, 'Transaction Remarks');
  assert.deepEqual(missingRequired(m, 'bank'), []);
});

// The one that a naive matcher gets wrong: "Value Date" and "Transaction Date"
// both look like dates, and only one of them is when the money moved.
test('prefers the value date over the transaction date', () => {
  const m = heuristicMapping(ICICI, 'bank');
  assert.equal(m.value_date.source_column, 'Value Date');
});

test('a single amount column plus a Cr/Dr flag still satisfies the schema', () => {
  const m = heuristicMapping(AXIS, 'bank');
  assert.equal(m.amount.source_column, 'AMOUNT');
  assert.equal(m.txn_type.source_column, 'DR|CR');
  assert.deepEqual(missingRequired(m, 'bank'), [], 'amount + indicator stands in for a credit column');
});

// Mapping one column onto two fields is the failure that does not announce
// itself: the bank leg keeps running and joins on the wrong key.
test('no source column is ever claimed by two fields', () => {
  for (const [headers, kind] of [[HDFC, 'bank'], [ICICI, 'bank'], [AXIS, 'bank'], [TALLY, 'ledger']]) {
    const cols = Object.values(heuristicMapping(headers, kind)).map((m) => m.source_column);
    assert.equal(new Set(cols).size, cols.length, `${kind} ${headers[0]}: a column was mapped twice`);
  }
});

test('a file that is missing a required column is reported, not guessed at', () => {
  const m = heuristicMapping(['Foo', 'Bar', 'Baz'], 'bank');
  assert.deepEqual(missingRequired(m, 'bank').sort(), ['credit', 'value_date']);
});

test('our own generated files are recognised as native and skip mapping entirely', () => {
  assert.equal(isNative(['txn_id', 'value_date', 'description', 'utr', 'credit', 'debit'], 'bank'), true);
  assert.equal(isNative(['invoice_id', 'order_ref', 'customer', 'invoice_date', 'amount', 'currency'], 'ledger'), true);
  assert.equal(isNative(HDFC, 'bank'), false);
});

// ---------------------------------------------------------------------------
// Dates. A date read the wrong way round shifts every credit by up to eleven
// days and turns correct matches into date_out_of_window exceptions, silently.
// ---------------------------------------------------------------------------

test('a column proves day-first when any first component exceeds 12', () => {
  const g = inferDateFormat(['05/08/2026', '17/08/2026', '02/09/2026']);
  assert.equal(g.format, 'DD/MM/YYYY');
  assert.equal(g.ambiguous, false);
});

test('a column proves month-first when any second component exceeds 12', () => {
  const g = inferDateFormat(['08/05/2026', '08/17/2026', '09/02/2026']);
  assert.equal(g.format, 'MM/DD/YYYY');
  assert.equal(g.ambiguous, false);
});

test('a column that cannot prove its own order says so instead of pretending', () => {
  const g = inferDateFormat(['05/08/2026', '03/07/2026', '11/12/2026']);
  assert.equal(g.ambiguous, true, 'every component is 12 or below — nothing here is proof');
  assert.equal(g.format, 'DD/MM/YYYY', 'defaults to the Indian reading');
});

test('spelled months and ISO are never ambiguous', () => {
  assert.equal(inferDateFormat(['05-Aug-2026', '17-Aug-2026']).ambiguous, false);
  assert.equal(inferDateFormat(['2026-08-05', '2026-08-17']).ambiguous, false);
});

test('parseDate reads the same string differently under each format', () => {
  assert.equal(parseDate('05/08/2026', 'DD/MM/YYYY'), '2026-08-05');
  assert.equal(parseDate('05/08/2026', 'MM/DD/YYYY'), '2026-05-08');
  assert.equal(parseDate('5-Aug-26', 'DD-MMM-YYYY'), '2026-08-05');
  assert.equal(parseDate('2026-8-5'), '2026-08-05');
});

test('an unreadable date returns null rather than a wrong date', () => {
  assert.equal(parseDate('not a date', 'DD/MM/YYYY'), null);
  assert.equal(parseDate('45/13/2026', 'DD/MM/YYYY'), null);
  assert.equal(parseDate(''), null);
});

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

test('Indian grouping, currency markers and Cr/Dr suffixes all parse', () => {
  assert.equal(cleanAmount('12,34,567.89'), '1234567.89');
  assert.equal(cleanAmount('₹ 1,250.00'), '1250.00');
  assert.equal(cleanAmount('INR 4,500.50 Cr'), '4500.50');
  assert.equal(cleanAmount(''), '0');
  assert.equal(cleanAmount('-'), '0');
});

test('accounting parentheses mean negative, not positive', () => {
  assert.equal(cleanAmount('(1,250.00)'), '-1250.00', 'stripping the brackets would flip the sign of the row');
  assert.equal(cleanAmount('1,250.00 Dr'), '-1250.00');
});

test('a single amount column is split by its direction indicator', () => {
  const rows = [
    { 'SRL NO': '1', 'Tran Date': '05/08/2026', PARTICULARS: 'NEFT RAZORPAY HDFCN2608219874', AMOUNT: '32,196.70', 'DR|CR': 'CR' },
    { 'SRL NO': '2', 'Tran Date': '06/08/2026', PARTICULARS: 'RENT', AMOUNT: '18,000.00', 'DR|CR': 'DR' },
  ];
  const mapping = heuristicMapping(AXIS, 'bank');
  const out = applyMapping(rows, mapping, 'bank', { dateFormat: 'DD/MM/YYYY' });

  assert.deepEqual(out[0], { txn_id: '1', value_date: '2026-08-05', description: 'NEFT RAZORPAY HDFCN2608219874', utr: '', credit: '32196.70', debit: '0' });
  assert.equal(out[1].credit, '0');
  assert.equal(out[1].debit, '18000.00');
});

// ---------------------------------------------------------------------------
// The model layer. Stubbed — these assert what happens to a model's answer, not
// what the model says.
// ---------------------------------------------------------------------------

const stubClient = (payload) => ({
  messages: {
    create: async () => ({
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    }),
  },
});

const rows = [{ Date: '05/08/2026', Narration: 'NEFT CR RAZORPAY HDFCN2608219874', 'Value Dt': '05/08/2026', 'Withdrawal Amt.': '', 'Deposit Amt.': '32,196.70' }];

test('a column the model invented is discarded, with a warning', async () => {
  const res = await mapTable({
    headers: HDFC, rows, kind: 'bank',
    client: stubClient({
      assignments: [
        { canonical_field: 'value_date', source_column: 'Value Dt', confidence: 1, reason: 'header and values agree' },
        { canonical_field: 'credit', source_column: 'Deposit Amt.', confidence: 1, reason: 'inbound money column' },
        { canonical_field: 'utr', source_column: 'UTR Number', confidence: 0.9, reason: 'invented' },
      ],
      date_format: 'DD/MM/YYYY', date_format_ambiguous: false, date_format_reason: 'day-first', notes: '',
    }),
  });

  assert.notEqual(res.mapping.utr?.source_column, 'UTR Number', 'a column not in the file must never reach applyMapping');
  assert.equal(res.mapping.utr?.source_column, 'Chq./Ref.No.', 'and the alias match it tried to override survives');
  assert.ok(res.warnings.some((w) => w.includes('UTR Number')));
  assert.equal(res.mapping.credit.source_column, 'Deposit Amt.');
});

test('the model cannot map two fields to the same column', async () => {
  const res = await mapTable({
    headers: HDFC, rows, kind: 'bank',
    client: stubClient({
      assignments: [
        { canonical_field: 'value_date', source_column: 'Value Dt', confidence: 1, reason: 'x' },
        { canonical_field: 'credit', source_column: 'Deposit Amt.', confidence: 1, reason: 'x' },
        { canonical_field: 'debit', source_column: 'Deposit Amt.', confidence: 1, reason: 'x' },
      ],
      date_format: 'DD/MM/YYYY', date_format_ambiguous: false, date_format_reason: 'x', notes: '',
    }),
  });
  assert.notEqual(res.mapping.debit?.source_column, 'Deposit Amt.', 'one column can never feed both directions');
  assert.ok(res.warnings.some((w) => w.includes('more than one field')));
  const cols = Object.values(res.mapping).map((m) => m.source_column);
  assert.equal(new Set(cols).size, cols.length);
});

test('a model failure falls back to the alias table rather than failing the ingest', async () => {
  const res = await mapTable({
    headers: HDFC, rows, kind: 'bank',
    client: { messages: { create: async () => { throw new Error('rate limit'); } } },
  });
  assert.equal(res.source, 'heuristic');
  assert.equal(res.mapping.credit.source_column, 'Deposit Amt.');
  assert.deepEqual(res.missing_required, []);
  assert.ok(res.warnings.some((w) => w.includes('rate limit')));
});

// ---------------------------------------------------------------------------
// The claim the ingest layer actually makes: the same month, re-exported in a
// bank's own format, reconciles to the same answer. Anything less and "works on
// any bank statement" is a hope rather than a property.
// ---------------------------------------------------------------------------

const inr = (n) => {
  if (!Number(n)) return '';
  const [w, f = '00'] = Number(n).toFixed(2).split('.');
  return `${Number(w).toLocaleString('en-IN')}.${f}`;
};
const ddmm = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

async function reingest(rows, kind, dateFormat = 'DD/MM/YYYY') {
  const res = await mapTable({ headers: Object.keys(rows[0]), rows, kind, useModel: false });
  assert.deepEqual(res.missing_required, [], `${kind}: required columns unresolved`);
  assert.equal(res.date_format.format, dateFormat);
  return applyMapping(rows, res.mapping, kind, { dateFormat: res.date_format.format });
}

test('a re-exported month reconciles identically through two foreign bank formats', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { parseCSV } = await import('../src/lib/csv.js');
  const { normaliseLedger, normaliseBank, normalisePayments } = await import('../src/sources/load.js');
  const { reconcile } = await import('../src/match/engine.js');

  const at = (f) => new URL(`../../data/demo/${f}`, import.meta.url);
  if (!existsSync(at('ledger.csv'))) return; // committed fixture absent; nothing to compare against

  const bank = parseCSV(readFileSync(at('bank_statement.csv'), 'utf8'));
  const ledger = parseCSV(readFileSync(at('ledger.csv'), 'utf8'));
  const reconRows = JSON.parse(readFileSync(at('recon_report.json'), 'utf8'));
  const payments = JSON.parse(readFileSync(at('payments.json'), 'utf8'));
  const settlements = JSON.parse(readFileSync(at('settlements.json'), 'utf8'));

  const base = {
    dir: 'test', manifest: {}, truth: null, settlements,
    payments: normalisePayments(reconRows, payments, settlements),
  };
  const native = reconcile({ ...base, ledger: normaliseLedger(ledger), bank: normaliseBank(bank) });

  // HDFC: a print date AND a value date, and no UTR column at all — the
  // reference lives inside the narration, which is the common real case.
  const hdfc = bank.map((r) => ({
    'Date': ddmm(r.value_date), 'Narration': r.description, 'Chq./Ref.No.': '',
    'Value Dt': ddmm(r.value_date), 'Withdrawal Amt.': inr(r.debit),
    'Deposit Amt.': inr(r.credit), 'Closing Balance': inr(r.balance),
  }));
  // Axis: one amount column for both directions, split by a CR/DR flag.
  const axis = bank.map((r, i) => ({
    'SRL NO': String(i + 1), 'Tran Date': ddmm(r.value_date), 'PARTICULARS': r.description,
    'AMOUNT': inr(Number(r.credit) || Number(r.debit)),
    'DR|CR': Number(r.credit) > 0 ? 'CR' : 'DR', 'BAL': inr(r.balance),
  }));
  // Tally: none of our column names, and the gateway order id renamed.
  const tally = ledger.map((r) => ({
    'Voucher No.': r.invoice_id, 'Date': ddmm(r.invoice_date), 'Party Name': r.customer,
    'Gateway Order Id': r.order_ref, 'Invoice Value': inr(r.amount),
  }));

  const fromTally = normaliseLedger(await reingest(tally, 'ledger'));
  for (const [label, rows] of [['hdfc', hdfc], ['axis', axis]]) {
    const run = reconcile({ ...base, ledger: fromTally, bank: normaliseBank(await reingest(rows, 'bank')) });
    assert.deepEqual(run.summary, native.summary, `${label} did not reconcile to the same answer`);
  }
});

// The committed datasets must not acquire a nondeterministic step in front of
// the pipeline that produced the published metrics.
test('a native file never reaches the model at all', async () => {
  let called = false;
  const res = await mapTable({
    headers: ['txn_id', 'value_date', 'description', 'utr', 'credit', 'debit'],
    rows: [{ txn_id: 'TXN1', value_date: '2026-08-05', description: 'x', utr: 'HDFCN1', credit: '100.00', debit: '0' }],
    kind: 'bank',
    client: { messages: { create: async () => { called = true; throw new Error('should not happen'); } } },
  });
  assert.equal(called, false);
  assert.equal(res.source, 'native');
});
