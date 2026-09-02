// The controlled vocabulary of the whole system. Every unmatched record must end
// up with exactly one of these codes — "unresolved" is the catch-all that exists
// so nothing can ever fall out of the report silently.

export const REASON = {
  AMOUNT_MISMATCH: 'amount_mismatch',
  MISSING_COUNTERPART: 'missing_counterpart',
  DUPLICATE_UTR: 'duplicate_utr',
  DATE_OUT_OF_WINDOW: 'date_out_of_window',
  AMBIGUOUS_CANDIDATES: 'ambiguous_candidates',
  UNRESOLVED: 'unresolved',
};

export const REASON_LABEL = {
  [REASON.AMOUNT_MISMATCH]: 'Amount mismatch',
  [REASON.MISSING_COUNTERPART]: 'Missing counterpart',
  [REASON.DUPLICATE_UTR]: 'Duplicate UTR',
  [REASON.DATE_OUT_OF_WINDOW]: 'Settlement outside expected window',
  [REASON.AMBIGUOUS_CANDIDATES]: 'Ambiguous — multiple candidates',
  [REASON.UNRESOLVED]: 'Unresolved',
};

export const STATUS = {
  MATCHED: 'matched',
  EXCEPTION: 'exception',
};

// Which rule fired. Reported alongside every match so a reviewer can see *why*
// the engine believed something, not just that it did.
export const RULE = {
  EXACT_REF: 'A1_exact_order_ref',
  EXACT_AMOUNT_DATE: 'A2_exact_amount_in_window',
  FUZZY_AMOUNT_DATE: 'A3_fuzzy_amount_in_window',
  BATCH_EXACT: 'B1_batch_utr_exact',
  BATCH_TOLERANCE: 'B2_batch_utr_within_tolerance',
  BATCH_SPLIT: 'B3_batch_utr_split_credits',
};

// Confidence is assigned by the rule that fired, not guessed. These are the only
// values the engine can emit, which makes "precision on high-confidence matches"
// a meaningful number rather than a vibe.
export const RULE_CONFIDENCE = {
  [RULE.EXACT_REF]: 1.0,
  [RULE.EXACT_AMOUNT_DATE]: 0.92,
  [RULE.FUZZY_AMOUNT_DATE]: 0.78,
  [RULE.BATCH_EXACT]: 1.0,
  [RULE.BATCH_TOLERANCE]: 0.8,
  // Lower than an exact single credit: the tranches summing correctly is strong
  // evidence but not proof that they belong to the same payout.
  [RULE.BATCH_SPLIT]: 0.85,
};

export const ALL_REASONS = Object.values(REASON);
