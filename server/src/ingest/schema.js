// What a bank statement and a merchant ledger have to look like by the time the
// engine sees them, and the deterministic first attempt at getting an arbitrary
// CSV into that shape.
//
// This file holds no AI. It is the floor: an alias table and a greedy assignment
// that resolves the columns most Indian bank exports actually use. The model in
// mapper.js is only asked about what this could not resolve, and its answer is
// written down with a reason so a human can overrule it.

/** Canonical fields, and what each one means to a reader who is not us. */
export const SCHEMAS = {
  bank: {
    label: 'bank statement',
    required: ['value_date', 'credit'],
    fields: {
      txn_id: 'A unique identifier for this statement line. Often a serial number.',
      value_date: 'The date the money actually moved — the value date, not the print date.',
      description: 'The free-text narration the bank wrote against this line.',
      credit: 'Money paid INTO the account on this line. Blank or zero on outgoing lines.',
      debit: 'Money paid OUT of the account on this line. Blank or zero on incoming lines.',
      amount: 'Only when the statement has ONE amount column for both directions, with the direction given by a separate indicator column.',
      txn_type: 'Only alongside a single amount column: the indicator saying whether the line is a credit or a debit (Cr/Dr, C/D, CREDIT/DEBIT).',
      utr: 'The bank reference number for the transfer (UTR / RRN / reference no). Often absent as a column and buried in the narration instead.',
    },
    aliases: {
      txn_id: ['txnid', 'transactionno', 'srlno', 'srno', 'sno', 'serialno', 'serialnumber', 'slno', 'entryid', 'id'],
      value_date: ['valuedate', 'valuedt', 'valuedt', 'dateofmovement', 'trandate', 'transactiondate', 'txndate', 'postingdate', 'bookingdate', 'date'],
      description: ['description', 'narration', 'particulars', 'transactionremarks', 'remarks', 'details', 'narrative', 'transactiondetails'],
      credit: ['credit', 'creditamount', 'creditamt', 'depositamt', 'depositamount', 'depositamountinr', 'creditinr', 'moneyin', 'deposit', 'cr'],
      debit: ['debit', 'debitamount', 'debitamt', 'withdrawalamt', 'withdrawalamount', 'withdrawalamountinr', 'debitinr', 'moneyout', 'withdrawal', 'dr'],
      amount: ['amount', 'transactionamount', 'txnamount', 'amountinr', 'amt'],
      txn_type: ['type', 'txntype', 'transactiontype', 'crdr', 'drcr', 'creditdebit', 'debitcreditflag', 'indicator'],
      utr: ['utr', 'utrno', 'utrnumber', 'reference', 'referenceno', 'refno', 'referencenumber', 'chequereferenceno', 'chqrefno', 'rrn', 'bankreference'],
    },
  },
  ledger: {
    label: 'merchant ledger',
    required: ['invoice_id', 'invoice_date', 'amount'],
    fields: {
      invoice_id: 'The merchant\'s own identifier for the invoice or bill.',
      order_ref: 'The payment gateway order id stored against the invoice, if the merchant records one. This is the strongest join key that exists, so do not confuse it with the invoice number.',
      customer: 'Who was billed.',
      invoice_date: 'The date the invoice was raised.',
      amount: 'The gross amount invoiced, before any gateway fee.',
      currency: 'Currency code, if present.',
    },
    aliases: {
      invoice_id: ['invoiceid', 'invoiceno', 'invoicenumber', 'invoice', 'billno', 'billnumber', 'documentno', 'docno', 'voucherno', 'vouchernumber'],
      order_ref: ['orderref', 'orderid', 'razorpayorderid', 'gatewayref', 'gatewayorderid', 'orderno', 'paymentref', 'pgref'],
      customer: ['customer', 'customername', 'party', 'partyname', 'partyaccountname', 'client', 'clientname', 'buyer', 'accountname', 'ledgername'],
      invoice_date: ['invoicedate', 'billdate', 'documentdate', 'docdate', 'voucherdate', 'issuedate', 'date'],
      amount: ['amount', 'invoiceamount', 'invoicevalue', 'totalamount', 'total', 'grandtotal', 'netamount', 'billamount', 'value', 'amountinr', 'debit'],
      currency: ['currency', 'curr', 'ccy'],
    },
  },
};

/** Header text down to comparable letters: "Deposit Amt. (INR)" -> "depositamtinr". */
export const normaliseHeader = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Greedy alias assignment. Scores every (canonical field, column) pair, then
 * takes the best pairs first so a column can only be claimed once — otherwise
 * "Transaction Id" ends up as both txn_id and utr and the bank leg quietly
 * matches on the wrong key.
 *
 * Each alias list is ordered most-specific first, and position costs a little
 * score. That is what decides HDFC, which ships both "Date" and "Value Dt": both
 * are exact alias hits, and without the ordering the tie breaks on column order
 * and picks the print date. The value date is when the money actually moved, so
 * every settlement-lag calculation downstream depends on winning this tie.
 */
export function heuristicMapping(headers, kind) {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`unknown table kind: ${kind}`);

  const rank = (aliases, test) => {
    const i = aliases.findIndex(test);
    return i === -1 ? null : i;
  };

  const candidates = [];
  for (const [field, aliases] of Object.entries(schema.aliases)) {
    for (const header of headers) {
      const n = normaliseHeader(header);
      if (!n) continue;
      let base = 0;
      let i = rank(aliases, (a) => a === n);
      if (i !== null) base = 0.95;
      else if ((i = rank(aliases, (a) => a.length >= 4 && (n.startsWith(a) || n.endsWith(a)))) !== null) base = 0.75;
      else if ((i = rank(aliases, (a) => a.length >= 5 && n.includes(a))) !== null) base = 0.6;
      // Capped well below the gap between tiers, so preference order only ever
      // breaks ties within a tier and never promotes a weaker kind of match.
      if (base) candidates.push({ field, header, score: base - Math.min(i, 9) * 0.005 });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.field.localeCompare(b.field));
  const mapping = {};
  const takenColumns = new Set();
  for (const c of candidates) {
    if (mapping[c.field] || takenColumns.has(c.header)) continue;
    mapping[c.field] = { source_column: c.header, confidence: c.score, reason: `header matches the known alias list for ${c.field}`, source: 'heuristic' };
    takenColumns.add(c.header);
  }
  return mapping;
}

/** Canonical fields the schema requires that this mapping has not resolved. */
export function missingRequired(mapping, kind) {
  const schema = SCHEMAS[kind];
  return schema.required.filter((f) => {
    if (mapping[f]?.source_column) return false;
    // A single amount column plus a Cr/Dr indicator satisfies credit.
    if (f === 'credit' && mapping.amount?.source_column && mapping.txn_type?.source_column) return false;
    return true;
  });
}

/** True when the file already uses our own field names, so no mapping is needed. */
export function isNative(headers, kind) {
  const set = new Set(headers.map((h) => String(h).trim()));
  return SCHEMAS[kind].required.every((f) => set.has(f));
}
