// Scoring the engine against ground truth.
//
// The metric that matters most is precision on the auto-matched set: a false
// match is money silently booked to the wrong invoice, and nobody ever looks at
// it again. A missed match only costs a human five minutes, so recall is the
// cheaper failure and the thresholds are tuned to protect precision first.

import { formatPaise } from '../lib/money.js';
import { STATUS, ALL_REASONS } from '../match/codes.js';

export function evaluate(dataset, result, elapsedMs = 0) {
  const truthByInvoice = new Map(dataset.truth.ledger.map((t) => [t.invoice_id, t]));
  const truthByTxn = new Map(dataset.truth.bank.map((t) => [t.txn_id, t]));

  let truePositive = 0;   // engine matched, truth agrees, same payment
  let falsePositive = 0;  // engine matched, truth says exception OR wrong payment
  let falseNegative = 0;  // engine flagged, truth says it was matchable
  let trueNegative = 0;   // engine flagged, truth agrees
  const misroutes = [];   // engine matched to the WRONG payment — the worst case
  const disagreements = [];
  const reasonConfusion = {};
  let reasonCorrect = 0;
  let reasonTotal = 0;

  for (const row of result.ledger) {
    const truth = truthByInvoice.get(row.invoice_id);
    if (!truth) continue;
    const engineMatched = row.status === STATUS.MATCHED;
    const truthMatched = truth.status === STATUS.MATCHED;

    if (engineMatched && truthMatched) {
      if (row.payment_id === truth.payment_id) truePositive++;
      else {
        falsePositive++;
        misroutes.push({ invoice_id: row.invoice_id, engine_payment: row.payment_id, true_payment: truth.payment_id });
      }
    } else if (engineMatched && !truthMatched) {
      falsePositive++;
      disagreements.push({ invoice_id: row.invoice_id, engine: 'matched',
        truth: `exception:${truth.reason}`, injected_fault: truth.fault, rule: row.rule });
    } else if (!engineMatched && truthMatched) {
      falseNegative++;
      disagreements.push({ invoice_id: row.invoice_id, engine: `exception:${row.reason}`,
        truth: 'matched', injected_fault: null, rule: row.rule });
    } else {
      trueNegative++;
      reasonTotal++;
      if (row.reason === truth.reason) reasonCorrect++;
      else {
        disagreements.push({ invoice_id: row.invoice_id, engine: `exception:${row.reason}`,
          truth: `exception:${truth.reason}`, injected_fault: truth.fault, rule: row.rule });
      }
      const key = `${truth.reason} -> ${row.reason}`;
      reasonConfusion[key] = (reasonConfusion[key] ?? 0) + 1;
    }
  }

  let bankCorrect = 0;
  for (const b of result.bank) {
    const truth = truthByTxn.get(b.txn_id);
    if (truth && (b.status === truth.status)) bankCorrect++;
  }

  const matched = result.ledger.filter((l) => l.status === STATUS.MATCHED);
  const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 1;
  const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 1;

  const byReason = Object.fromEntries(
    ALL_REASONS.map((r) => [r, result.ledger.filter((l) => l.reason === r).length]),
  );

  const records = dataset.ledger.length + dataset.payments.length + dataset.bank.length;

  return {
    dataset: dataDirOf(dataset),
    seed: dataset.manifest?.seed ?? null,
    generated_at: new Date().toISOString(),
    throughput: {
      records,
      elapsed_ms: Number(elapsedMs.toFixed(1)),
      records_per_second: elapsedMs ? Math.round(records / (elapsedMs / 1000)) : null,
    },
    volume: {
      ledger_rows: result.summary.ledger_rows,
      payments: dataset.payments.length,
      bank_rows: dataset.bank.length,
      settlement_batches: result.summary.settlement_groups,
    },
    accuracy: {
      match_rate: round(result.summary.match_rate),
      precision_auto_matched: round(precision),
      recall: round(recall),
      f1: round(precision + recall ? (2 * precision * recall) / (precision + recall) : 0),
      true_positive: truePositive,
      false_positive: falsePositive,
      false_negative: falseNegative,
      true_negative: trueNegative,
      misrouted_matches: misroutes.length,
      reason_code_accuracy: round(reasonTotal ? reasonCorrect / reasonTotal : 1),
      bank_row_accuracy: round(result.bank.length ? bankCorrect / result.bank.length : 1),
    },
    value: {
      auto_reconciled_paise: result.summary.value_matched_paise,
      flagged_paise: result.summary.value_flagged_paise,
      auto_reconciled_share: round(
        result.summary.value_matched_paise /
        Math.max(1, result.summary.value_matched_paise + result.summary.value_flagged_paise),
      ),
      unexplained_bank_credit_paise: result.summary.bank_unexplained_credit_paise,
    },
    exceptions_by_reason: byReason,
    matches_by_rule: countBy(matched, (m) => m.rule),
    reason_confusion: reasonConfusion,
    misroutes,
    disagreements,
    ground_truth: dataset.truth.summary,
  };
}

function dataDirOf(ds) { return ds.dir?.split('/').slice(-2).join('/') ?? ds.dir; }
function round(n) { return Number(n.toFixed(4)); }
function countBy(arr, fn) {
  return arr.reduce((acc, x) => { const k = fn(x) ?? 'none'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
}

export function printReport(r) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  console.log(`\nRecon — measured accuracy on ${r.dataset} (seed ${r.seed})\n`);
  console.log(`  ${r.throughput.records} records across 3 sources, ${r.throughput.elapsed_ms}ms (${r.throughput.records_per_second}/s)`);
  console.log(`  ${r.volume.ledger_rows} invoices | ${r.volume.payments} payments | ${r.volume.bank_rows} bank credits | ${r.volume.settlement_batches} settlement batches\n`);
  const a = r.accuracy;
  console.log(`  match rate                ${pct(a.match_rate)}`);
  console.log(`  precision (auto-matched)  ${pct(a.precision_auto_matched)}   ${a.false_positive} false positive(s), ${a.misrouted_matches} misrouted`);
  console.log(`  recall                    ${pct(a.recall)}   ${a.false_negative} missed`);
  console.log(`  reason-code accuracy      ${pct(a.reason_code_accuracy)}`);
  console.log(`  bank row accuracy         ${pct(a.bank_row_accuracy)}`);
  console.log(`\n  auto-reconciled  Rs ${formatPaise(r.value.auto_reconciled_paise)}  (${pct(r.value.auto_reconciled_share)} of value)`);
  console.log(`  flagged          Rs ${formatPaise(r.value.flagged_paise)}`);
  console.log(`  unexplained bank credit  Rs ${formatPaise(r.value.unexplained_bank_credit_paise)}`);
  console.log('\n  exceptions by reason');
  for (const [k, v] of Object.entries(r.exceptions_by_reason)) if (v) console.log(`    ${k.padEnd(24)} ${v}`);
  console.log('\n  matches by rule');
  for (const [k, v] of Object.entries(r.matches_by_rule)) console.log(`    ${k.padEnd(34)} ${v}`);
  if (r.disagreements.length) {
    console.log(`\n  ${r.disagreements.length} disagreement(s) with ground truth:`);
    for (const d of r.disagreements.slice(0, 15)) {
      console.log(`    ${d.invoice_id}  engine=${d.engine}  truth=${d.truth}  fault=${d.injected_fault ?? '-'}`);
    }
    if (r.disagreements.length > 15) console.log(`    ... and ${r.disagreements.length - 15} more (see metrics.json)`);
  }
}
