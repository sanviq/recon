import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPaise, paiseToDecimal, razorpayFees, formatPaise } from '../src/lib/money.js';
import { toCSV, parseCSV } from '../src/lib/csv.js';
import { addDays, daysBetween } from '../src/lib/dates.js';
import { extractUTR, normaliseBank } from '../src/sources/load.js';

test('rupee strings survive the round trip into paise and back', () => {
  for (const s of ['0.00', '1.00', '1234.56', '99999.99', '0.01', '-45.30']) {
    assert.equal(paiseToDecimal(toPaise(s)), s);
  }
});

test('paise arithmetic does not drift the way float rupees do', () => {
  // 0.1 + 0.2 !== 0.3 in float rupees, which invents amount mismatches that do
  // not exist. In paise the same sum is exact.
  assert.equal(toPaise('0.10') + toPaise('0.20'), toPaise('0.30'));
  const many = Array.from({ length: 1000 }, () => toPaise('0.07')).reduce((a, b) => a + b, 0);
  assert.equal(many, toPaise('70.00'));
});

test('amounts with currency symbols and separators still parse', () => {
  assert.equal(toPaise('₹1,234.56'), 123456);
  assert.equal(toPaise('1,00,000.00'), 10_000_000);
  assert.throws(() => toPaise(''), /not an amount/);
});

test('the bank credit is amount minus fee minus GST, never the invoice amount', () => {
  const { fee, tax, net } = razorpayFees(100_000); // Rs 1000.00
  assert.equal(fee, 2_000);            // 2%
  assert.equal(tax, 360);              // 18% GST on the fee
  assert.equal(net, 97_640);
  assert.ok(net < 100_000);
});

test('formatting uses the Indian grouping a finance user expects', () => {
  assert.equal(formatPaise(1_48_79_64_53), '14,87,964.53');
});

test('CSV survives quotes, commas and newlines inside fields', () => {
  const rows = [{ a: 'plain', b: 'has,comma', c: 'has"quote', d: 'has\nnewline' }];
  assert.deepEqual(parseCSV(toCSV(rows)), rows);
});

test('CSV parsing skips blank trailing lines rather than inventing a row', () => {
  assert.equal(parseCSV('a,b\n1,2\n\n').length, 1);
});

test('the UTR is dug out of the narration when there is no UTR column', () => {
  // Real bank statements frequently have no UTR column at all. Missing this
  // silently destroys the entire bank leg.
  assert.equal(extractUTR({ utr: 'CITIN2608057696' }), 'CITIN2608057696');
  assert.equal(
    extractUTR({ description: 'NEFT CR RAZORPAY SOFTWARE PVT LTD HDFCN2608120041' }),
    'HDFCN2608120041',
  );
  assert.equal(extractUTR({ description: 'CASH DEPOSIT' }), '');
});

test('debit rows are excluded — settlement recon is about inbound money', () => {
  const rows = normaliseBank([
    { txn_id: 'T1', value_date: '2026-08-05', utr: 'U1', credit: '100.00', debit: '0.00' },
    { txn_id: 'T2', value_date: '2026-08-05', utr: '', credit: '0.00', debit: '500.00' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].txn_id, 'T1');
});

test('day arithmetic crosses month boundaries without timezone drift', () => {
  assert.equal(addDays('2026-08-30', 5), '2026-09-04');
  assert.equal(daysBetween('2026-08-30', '2026-09-04'), 5);
  assert.equal(daysBetween('2026-09-04', '2026-08-30'), -5);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1); // 2026 is not a leap year
});
