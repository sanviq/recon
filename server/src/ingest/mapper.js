// The AI ingest layer: reading a bank statement or ledger nobody wrote for us.
//
// Every bank in India exports a different file. HDFC writes "Narration" and
// "Deposit Amt.", ICICI writes "Transaction Remarks" and "Deposit Amount(INR)",
// Axis writes "PARTICULARS" and a single "AMOUNT" column with a separate CR/DR
// flag. There is no standard and there never will be, which makes column mapping
// the exact shape of problem a language model is good at and a rule table is not:
// unbounded, fuzzy, and obvious to any human who looks at three rows.
//
// It is also the exact shape of problem that must not be trusted blindly, so:
//
//   1. A deterministic alias table runs first and resolves most real files with
//      no model at all. The model is asked to review that proposal, not to start
//      from nothing.
//   2. Every decision carries a confidence and a reason in plain English, and
//      the whole mapping is written to ingest.json before a single row is read.
//   3. The mapping only renames columns and parses dates. It never touches an
//      amount comparison, a match, or a reason code — by the time the engine
//      runs, the AI has been out of the building for a step.

import { getClient, hasProvider, parseModelJson } from '../llm/client.js';
import { SCHEMAS, heuristicMapping, missingRequired, isNative, normaliseHeader } from './schema.js';
import { inferDateFormat, DATE_FORMATS, applyMapping } from './values.js';

const MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You map columns in a finance CSV onto a fixed internal schema, for a reconciliation tool used by Indian merchants who accept payments through Razorpay.

You will be given the schema, the CSV's real header row, a few sample rows, and a proposal from a deterministic alias matcher. Correct the proposal where it is wrong and complete it where it is missing.

How to decide:
- Read the sample values, not just the header text. A column called "Amount" holding "12,500.00" and a column called "Amount" holding "INV-2026-0031" are not the same column.
- Indian formatting is normal: 12,34,567.89 grouping, dd/mm/yyyy dates, Rs and INR markers, "Cr"/"Dr" indicators, accounting parentheses for negatives.
- Leave a field unmapped rather than forcing a bad guess. A missing column is visible and fixable. A wrong column silently reconciles the wrong money.
- Never map two schema fields to the same source column.
- confidence: 1.0 only when the header and the sample values both make it unambiguous. 0.5-0.8 when the values make it clear but the header is odd, or the reverse. Below 0.5 when you are genuinely unsure — say so rather than rounding up.
- reason: one short clause naming the actual evidence you used, e.g. "values are all dd/mm/yyyy dates and the header says Value Dt". Not "this seems right".

Date format: pick the format the date column is actually written in. If the sample values cannot prove day-first versus month-first (every component is 12 or below), the file is from an Indian bank, so day-first is the right reading — but set date_format_ambiguous to true so the tool tells the user it was inferred rather than proven.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          canonical_field: { type: 'string' },
          source_column: { type: ['string', 'null'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['canonical_field', 'source_column', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
    date_format: { type: 'string', enum: DATE_FORMATS },
    date_format_ambiguous: { type: 'boolean' },
    date_format_reason: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['assignments', 'date_format', 'date_format_ambiguous', 'date_format_reason', 'notes'],
  additionalProperties: false,
};

export function hasApiKey() {
  return hasProvider();
}

/** The first few rows, as the model (and the user) would see them in a preview. */
export function sampleRows(rows, n = 4) {
  return rows.slice(0, n);
}

function buildPrompt({ headers, rows, kind, proposal, dateGuess }) {
  const schema = SCHEMAS[kind];
  const fields = Object.entries(schema.fields)
    .map(([f, desc]) => `  ${f}${schema.required.includes(f) ? ' (required)' : ''} — ${desc}`)
    .join('\n');
  const proposed = Object.entries(proposal)
    .map(([f, m]) => `  ${f} <- "${m.source_column}" (${m.confidence})`)
    .join('\n') || '  (nothing resolved)';

  return `Table kind: ${schema.label}

Internal schema:
${fields}

CSV header row (${headers.length} columns):
${headers.map((h) => `  "${h}"`).join('\n')}

Sample rows:
${JSON.stringify(sampleRows(rows), null, 2)}

Deterministic alias matcher proposed:
${proposed}

Its date-format guess: ${dateGuess.format} (${dateGuess.ambiguous ? 'ambiguous' : 'proven'} — ${dateGuess.evidence})

Return the final mapping. Include an entry for every schema field, using null for the ones this file does not have.`;
}

/**
 * Resolves one table's columns.
 *
 * Returns a mapping plus everything needed to audit it: which layer decided each
 * field, how sure it was, why, and what it could not resolve. Never throws on a
 * model failure — it falls back to the heuristic, which is what would have run
 * anyway if there were no key.
 */
export async function mapTable({ headers, rows, kind, client, useModel = true }) {
  if (!SCHEMAS[kind]) throw new Error(`unknown table kind: ${kind}`);

  // A file already in our own vocabulary needs no interpretation, and running the
  // model over it would put a nondeterministic step in front of the scored
  // pipeline for no reason. The committed datasets take this path.
  if (isNative(headers, kind)) {
    const dateField = kind === 'bank' ? 'value_date' : 'invoice_date';
    const mapping = Object.fromEntries(
      Object.keys(SCHEMAS[kind].fields)
        .filter((f) => headers.includes(f))
        .map((f) => [f, { source_column: f, confidence: 1, reason: 'file already uses the canonical field name', source: 'native' }]),
    );
    return {
      kind, source: 'native', mapping,
      date_format: inferDateFormat(rows.map((r) => r[dateField])),
      unmapped_columns: headers.filter((h) => !mapping[h]),
      missing_required: missingRequired(mapping, kind),
      warnings: [],
    };
  }

  const dateField = kind === 'bank' ? 'value_date' : 'invoice_date';
  const proposal = heuristicMapping(headers, kind);
  const dateColumn = proposal[dateField]?.source_column;
  const dateGuess = inferDateFormat(dateColumn ? rows.map((r) => r[dateColumn]) : []);

  const api = client ?? (useModel ? getClient() : null);
  let mapping = proposal;
  let source = 'heuristic';
  let dateFormat = { ...dateGuess, source: 'heuristic' };
  const warnings = [];

  if (api) {
    try {
      const response = await api.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        messages: [{ role: 'user', content: buildPrompt({ headers, rows, kind, proposal, dateGuess }) }],
      });

      if (response.stop_reason === 'refusal') throw new Error('refusal');
      const parsed = parseModelJson(response.content.find((b) => b.type === 'text')?.text ?? '');

      const resolved = {};
      const taken = new Set();
      for (const a of parsed.assignments) {
        // The model is not trusted to stay inside the schema or inside the file:
        // a hallucinated column name here would map every row to undefined.
        if (!SCHEMAS[kind].fields[a.canonical_field]) continue;
        if (!a.source_column) continue;
        if (!headers.includes(a.source_column)) {
          warnings.push(`model proposed column "${a.source_column}" for ${a.canonical_field}, which is not in the file — ignored`);
          continue;
        }
        if (taken.has(a.source_column)) {
          warnings.push(`model mapped "${a.source_column}" to more than one field — kept the first`);
          continue;
        }
        taken.add(a.source_column);
        resolved[a.canonical_field] = {
          source_column: a.source_column,
          confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)),
          reason: a.reason,
          source: 'llm',
        };
      }

      for (const [field, m] of Object.entries(proposal)) {
        if (!resolved[field] && !taken.has(m.source_column)) {
          warnings.push(`model dropped ${field} <- "${m.source_column}"; kept the alias match`);
          resolved[field] = m;
          taken.add(m.source_column);
        }
      }

      mapping = resolved;
      source = 'llm';
      dateFormat = {
        format: DATE_FORMATS.includes(parsed.date_format) ? parsed.date_format : dateGuess.format,
        ambiguous: Boolean(parsed.date_format_ambiguous),
        evidence: parsed.date_format_reason,
        source: 'llm',
      };
      if (parsed.notes) warnings.push(`model note: ${parsed.notes}`);
    } catch (err) {
      warnings.push(`model mapping unavailable (${err?.message ?? err}) — used the deterministic alias table`);
    }
  } else if (useModel) {
    warnings.push('no ANTHROPIC_API_KEY — used the deterministic alias table only');
  }

  const takenColumns = new Set(Object.values(mapping).map((m) => m.source_column));
  return {
    kind, source, mapping, date_format: dateFormat,
    unmapped_columns: headers.filter((h) => !takenColumns.has(h)),
    missing_required: missingRequired(mapping, kind),
    warnings,
  };
}

/** Human-readable mapping table for the CLI and the ingest.json record. */
export function describeMapping(res) {
  const rows = Object.entries(res.mapping)
    .map(([field, m]) => ({ field, column: m.source_column, confidence: m.confidence, by: m.source, reason: m.reason }))
    .sort((a, b) => a.field.localeCompare(b.field));
  return rows;
}

export { MODEL, SYSTEM_PROMPT, applyMapping, normaliseHeader };
