# Architecture

How Recon is put together, what the matching algorithm actually does, and why every
threshold has the value it has.

---

## 1. Data flow

```
                 ┌──────────────────────────── sources ────────────────────────────┐
                 │                                                                  │
  Razorpay API   │  payments.all()          ─┐                                      │
  (test mode)    │  settlements.all()        ├─▶ recon_report.json  (payment ↔ UTR) │
                 │  settlements.reports()   ─┘                                      │
                 │                                                                  │
  Merchant       │  ledger.csv               ──▶ invoice, amount, date, order_ref   │
  Bank           │  bank_statement.csv       ──▶ txn, value_date, UTR, credit        │
                 └──────────────────────────────────┬───────────────────────────────┘
                                                    │
                              ingest/ — foreign CSVs only (AI, optional)
                       alias table → model review → ingest.json → canonical CSVs
                                                    │
                                      sources/load.js — normalisation
                             (one internal shape, integer paise, UTR extraction)
                                                    │
                                      match/engine.js — deterministic
                             ┌──────────────────────┴──────────────────────┐
                        Leg A: ledger ↔ payment              Leg B: UTR group ↔ bank credit
                        A1 reference → A2 exact → A3 fuzzy    B1 exact → B2 tolerance → B3 split
                             └──────────────────────┬──────────────────────┘
                                                    │
                                        combine: matched only if BOTH hold
                                                    │
                          ┌─────────────────────────┼─────────────────────────┐
                    result.json                audit.jsonl               eval/score.js
                (per-record decisions)      (append-only trail)      (vs. truth.json → metrics)
                          │                                                    │
           explain/ — notes + month-end brief                          metrics.json
             (Claude, or deterministic templates)                              │
                          │                                                    │
                          ├──── agent/ — ask, over read-only tools ────┐       │
                          │        (Claude; disabled without a key)    │       │
                          │                                           │       │
                          └────────────────▶ web/index.html ◀─────────┴───────┘
                                    (read-only dashboard over the artefacts)
```

The CLI does all the work and writes files; the server only serves them. That is
deliberate — what the dashboard shows is the same artefact the metrics table was
computed from, not a second code path that can disagree with it.

### Normalisation is the seam

`sources/load.js` is the only place that knows three sources speak three
vocabularies. Everything downstream sees one shape and integer paise, so the engine
never knows whether a record came from a CSV export, a bank download, or the API.
Swapping the fixture loader for the live client changes nothing below that file.

Two details in there earn their keep:

- **UTR extraction.** Real bank statements frequently have no UTR column — it is
  buried in the narration string. The loader takes the column when it exists and
  otherwise digs it out of the description with `\b([A-Z]{4}[A-Z0-9]{6,18})\b`.
  Getting this wrong silently destroys the entire bank leg.
- **Net is recomputed, never trusted.** `net = amount − fee − tax` is calculated
  locally rather than read from a reported field, so a gateway that reports a fee
  differently from what it charged shows up as a real discrepancy.

---

## 2. The matching algorithm

### Leg A — ledger invoice ↔ Razorpay payment

Three **global passes**, not a per-row decision. Order matters: every reference
match across the whole ledger is settled before any amount-based inference is
allowed, so a strong match can never lose its payment to a weaker one that happened
to be evaluated first. A payment, once claimed, is removed from the candidate pool —
one payment can never be claimed by two invoices.

**A1 — gateway reference.** `ledger.order_ref` ↔ `payment.order_id`. The only join
key that is an *identity claim* rather than an inference, so it wins outright —
including when the amounts disagree. A row we can positively identify whose amount is
wrong is an `amount_mismatch` to investigate, not an unmatched row. Confidence 1.00.

**A2 — exact amount + date window.** For rows with no usable reference. Requires the
amount to be exactly equal and the payment date inside the window. Confidence 0.92.

**A3 — tolerant amount + date window.** Same, but allowing rounding tolerance.
Confidence 0.78.

Both A2 and A3 **refuse to choose when more than one payment fits.** More than one
candidate → `ambiguous_candidates`, confidence 0, no payment assigned. This is the
single most important safety property in the system: guessing here is what produces a
confident, wrong reconciliation, and money booked to the wrong invoice is never found
again.

Whatever remains has no counterpart in the gateway at all → `missing_counterpart`.
The mirror image — captured payments no ledger row ever claimed — is reported on the
payment side, because that is a bookkeeping hole rather than a missing payment.

### Window calibration

Between A1 and A2, the engine derives the date window from the A1 matches it just
made. Those are pairs the gateway reference already proved correct, so each one is a
free, ground-truth observation of this merchant's actual payment lag.

```
window.max = min(maxDays, max(configured_default, observed_max_gap))
window.min = min(configured_default, observed_min_gap)
```

- **Only ever widened past the configured default, never tightened below it.** The
  default is a floor on coverage, not a target.
- **Uses the observed maximum** (`percentile: 1.0`), not a trimmed percentile. These
  gaps come from pairs already proved correct, so the largest is a lag that genuinely
  happened — not an outlier to smooth away. Measured over 40 unseen hard-profile
  seeds: p95 gave 90.9% recall with one misroute; the observed max gave 95.4% with
  none.
- **`maxDays: 14`** stops a single garbage date from opening the window indefinitely.
- **Needs ≥ 8 samples**, else it falls back to the configured default. A window fitted
  to three data points is not a measurement, and silently trusting it would be worse
  than a sensible constant.

Precision is protected by the ambiguity guard, not by keeping the window narrow — see
the sensitivity table in the README for the measurement behind that claim.

### Leg B — settlement UTR ↔ bank credit

This is the batch match, and it is the part row-to-row matching cannot do at all.
Payments are grouped by the UTR the recon report says paid them out; the group's
expected credit is the sum of the recomputed nets; that one number is matched against
the bank.

| Bank rows for the UTR | Outcome |
|---|---|
| 0 | `missing_counterpart` — Razorpay says it paid, the bank has no record. Never auto-cleared. |
| 1, date outside window | `date_out_of_window` |
| 1, \|Δ\| > tolerance | `amount_mismatch` |
| 1, within tolerance | matched — `B1` if Δ is exactly 0, else `B2` |
| >1, sum within tolerance | matched — `B3`, a split payout |
| >1, sum overshoots | `duplicate_utr` |

**Date is checked before amount, deliberately.** A credit that arrives nine days late
may still be the right amount, and reporting it as an amount match would hide the
fact that the cash was not where the books said it was.

**Split vs. duplicate is decided by the sum.** Tranches that add up to the payout are
normal Razorpay behaviour — treating them as a duplicate would flag a perfectly good
batch. A sum that overshoots is a genuine double-post: the cash position is
overstated, no rule can safely pick which row is real, and a human has to decide.

Bank credits whose UTR Razorpay never issued are flagged `missing_counterpart` on the
bank side. A reconciliation that only looks for what it expects will happily miss cash
it cannot account for.

### Combining the legs

An invoice is `matched` only if both legs hold.

- Leg A failed → leg A's reason wins (we don't know which settlement to look at).
- Leg A held, leg B failed → the invoice inherits its batch's problem, because that is
  the reason its money is not confirmed.
- Confidence is `min(legA, legB)`, never the average — a chain is not more trustworthy
  than its weakest link.

That inheritance is why an invoice can match its payment to the paise and still be
flagged `amount_mismatch`: the batch that paid it out was short-credited. The
explainer carries a `failing_leg` field precisely so the note describes the leg that
actually broke.

---

## 3. Thresholds, and why

| Threshold | Value | Reasoning |
|---|---|---|
| `ledgerDateWindow` | −1 to +3 days (floor; calibrated upward) | Customers pay a day or two after the invoice; nobody pays before it exists, so the window is asymmetric. One day back only absorbs a late-entered ledger row. |
| `bankCreditWindow` | −1 to +3 days | Razorpay's standard cycle is T+2 and the recon report already gives the settled date, so this only has to absorb bank posting lag and weekends. |
| `amountTolerance` | floor ₹2, 5 bps, cap ₹100 | Absorbs **rounding only** — GST on the fee is rounded to the paise, and merchants round by hand. Deliberately far too small to swallow a keying error: injected drift is sub-rupee, injected typos start at ₹400. The cap means a large invoice never gets a proportionally large blind spot. |
| `batchTolerance` | floor ₹5, 5 bps, cap ₹100 | Slightly looser: a settlement total is a sum of many rounded nets, so rounding accumulates across the batch. Injected short-credits start at ₹150. |
| `calibration.minSamples` | 8 | Below this, a fitted window is noise. |
| `calibration.percentile` | 1.0 (observed max) | See above — measured, not assumed. |
| `calibration.maxDays` | 14 | Bounds the blast radius of one bad date. |

Every one of these is overridable per run via the `reconcile(dataset, config)`
argument; the sweep exposes `--ledger-window-max` and `--amount-tolerance-bps` so
sensitivity can be measured rather than argued about.

**Confidence values are assigned by the rule that fired, not guessed.** They are the
only values the engine can emit, which is what makes "precision on high-confidence
matches" a meaningful number rather than a vibe.

---

## 4. The audit trail

`audit.jsonl` — one JSON object per line, one line per decision.

```json
{"run_id":"run_1756...","seq":42,"at":"2026-09-02T...","leg":"A","subject":"ledger",
 "subject_id":"INV-2026-0046","decision":"matched","rule":"A1_exact_order_ref",
 "reason":null,"confidence":1,"counterpart":"pay_R00007043",
 "detail":{"matched_on":"order_ref","date_gap_days":2}}
```

Append-only **by construction**: every run appends its decisions and nothing ever
rewrites an earlier line. Sequence numbers are dense and ordered within a run, so a
removed line is detectable. That is the property that makes it evidence rather than a
report.

It records the calibration decision, every leg-A and leg-B decision, the combined
per-invoice verdict, and every explanation — including whether a model or a template
wrote it, and the hash of the facts it was given. If a note looks wrong, you can tell
from the trail whether the engine or the writer was at fault.

---

## 5. Where the language model sits, and where it does not

```
  messy CSV ─▶ [Claude: ingest] ─▶ canonical rows ─▶ [deterministic engine] ─▶ decisions
                      │                                       ▲                    │
              renames columns,                        money decisions              │
              parses dates                            happen HERE                  │
              never touches a value                                                ▼
                                                                          [Claude: explain]
                                                                          [Claude: ask]
                                                                        prose over settled facts
```

Three model-facing layers, one rule: **the model is allowed to interpret the input and
narrate the output. It is never allowed to decide where money went.**

### 5.1 Ingest — the only layer that runs *before* the engine

Column mapping is unbounded and fuzzy: every bank exports a different file and no
standard exists. That is a model problem. So the risk is managed structurally rather
than by trusting the answer:

1. A deterministic alias table proposes a mapping first, and resolves most real files
   alone. The model reviews that proposal instead of starting cold.
2. Its answer is filtered before use — a column not present in the file is discarded
   with a warning, and one source column can never feed two schema fields. A
   hallucinated column name would otherwise map every row to `undefined`.
3. A required field it cannot resolve **aborts the ingest**. Nothing is written.
4. The whole mapping is recorded in `ingest.json` and appended to `audit.jsonl` with a
   confidence and a plain-English reason per field, before a single row is read.
5. A file already using our own field names takes a native path and never reaches the
   model — the committed datasets stay deterministic end to end.

The alias lists are ordered most-specific first, and position costs a little score.
That single detail is what decides HDFC, which ships both `Date` and `Value Dt`: both
are exact alias hits, and without the ordering the tie breaks on column order and picks
the print date. Every settlement-lag calculation downstream depends on winning that tie.

Dates are inferred from the whole column, not one cell. A value with a first component
above 12 proves day-first; one with a second component above 12 proves month-first;
when nothing proves either, the run reports `INFERRED, not proven`. A date read the
wrong way round does not throw — it shifts every credit by up to eleven days.

### 5.2 Explain — notes and the month-end brief

By the time an exception reaches the explainer, the reason code, the confidence and
the counterpart records are all fixed. The model receives a narrow set of facts —
already converted to rupees, so it never does arithmetic — and writes three fields
under a JSON schema: `explanation`, `suggested_action`, `severity`.

The **brief** is one call over the aggregate rather than one per record, because nobody
opens a reconciliation wanting forty rows explained; they want to know whether the month
is fine and what to do first. Invoices flagged by a single broken payout are grouped
before the model sees them, so five rows sharing one cause are presented as one problem.

**Request shape.** Whichever provider the chain resolves to — `claude-opus-5` on a
paid Anthropic key, otherwise `gemini-3.6-flash` or `openai/gpt-oss-120b` on a free
tier — with structured output. `effort: low` for the notes
(formatting over settled facts) and `medium` for the brief (deciding what to lead with is
a judgement over the whole month). The system prompt is constant and carries the
`cache_control` breakpoint; the per-exception facts go in the user turn *after* it, so the
whole batch shares one cached prefix. One request is sent alone to warm the cache before
the rest fan out at bounded concurrency — a cache entry only becomes readable once the
first response starts streaming, so firing everything at once would mean every call pays
full price.

**Grounding.** A prompt saying "use only the figures given" is a request. The check
that makes it a property runs on every note before it reaches the report:
`checkNoteAgainstFacts()` extracts every identifier and rupee amount from the prose
and looks for each in the serialised fact pack.

An unsupported **identifier** — an invoice id, UTR, payment id or bank transaction id
that was never supplied — is invention with no legitimate cause, so the note is
discarded and the template used, with the offending ids named in `fallback_reason`.
An unsupported **amount** is usually the model deriving a shortfall it was told not to
compute; that is recorded on the note and reported in the run summary rather than
suppressed, because discarding an otherwise correct note over it trades a small risk
for a certain loss of clarity.

The identifier patterns are deliberately shape-specific (`INV-…`, `pay_…`, `TXN…`,
and bank prefixes like `HDFC`/`ICIC`/`NEFT`). A bare "any uppercase token" rule would
flag GST, UTR and NEFT themselves and make the check useless through false positives.

### 5.3 Ask — an agent that cannot write

The agent answers questions by calling seven tools over a finished run. Every one is a
read. There is no tool that matches, clears, re-runs or edits anything — so *"the model
must not clear an exception"* is not an instruction it could disobey, it is the absence
of a capability. Two tests hold that shut: one calls every tool and asserts the result is
byte-identical afterwards, another asserts the declared tool list and the implemented one
are the same set, so a write tool cannot be added quietly.

The loop is hand-written rather than delegated to the SDK's tool runner, because the
**trace is half the product**: every tool call and argument is captured and returned with
the answer, and rendered under it in the dashboard. An answer a model wrote about money is
worth exactly the records it is provably built from.

`thinking: {type: 'adaptive'}`, `max_tokens: 8192`, capped at 8 iterations. Hitting the
cap returns "narrow the question" rather than whatever half-answer exists. Amounts reach
the model as formatted rupee strings, never paise integers, so it reads numbers instead of
doing arithmetic on them; where a total is genuinely needed, a tool computes it.

### 5.4 Provider independence, and why it was cheap

All four model call sites are written as `client ?? getClient()`. That parameter
exists because the tests needed to hand them fakes, and it turned out to be the
same seam a second provider plugs into: `server/src/llm/` translates the Anthropic
Messages shape to Google Gemini and to Groq's OpenAI-compatible dialect, and
nothing above that directory knows which company answered.

The translation is not cosmetic, and each difference is a real failure if missed:

| Anthropic | Gemini | Groq (OpenAI) |
|---|---|---|
| `system` as blocks carrying `cache_control` | one `systemInstruction` string | a `system` message |
| `additionalProperties: false` **required** by strict schemas | **rejected with a 400** — schema rebuilt from a whitelist | ignored |
| `type: ['string','null']` | single type + `nullable` | ignored |
| tool call carries an `id` | no id — one is minted so results can be paired | `tool_calls[].id` |
| tool result keyed by `tool_use_id` | keyed by tool **name**, recovered by indexing the transcript | `tool_call_id` |
| several results in one user turn | several `functionResponse` parts | one `tool` message each |
| `stop_reason: 'refusal'` | `finishReason: 'SAFETY'` | `finish_reason: 'content_filter'` |
| JSON schema enforced | `responseSchema` enforced | JSON mode only — schema restated in the prompt |

Providers are tried in order and the first that answers wins. One that fails in a
way a retry cannot fix — a bad key, an unfunded account, an unknown model — is
dropped for the rest of the process, so a 24-exception batch pays that failure once
rather than 24 times; the reason it was dropped is carried forward, because 23
notes reporting "no provider configured" would send someone hunting a missing key
when the first note had already named the real cause. A 429 is explicitly **not**
permanent: a free tier that has run out for the minute falls through now and is
offered the work again later.

Two consequences worth stating. First, notes record the model that **actually**
wrote them rather than the one that was requested, because an audit trail that
files a Llama sentence under Opus is lying about provenance. Second, model JSON is
parsed tolerantly — open-weights models in JSON mode still wrap their answer in a
code fence often enough that a strict `JSON.parse` would throw away good notes.

Below every provider sits the template path, which needs no key and cannot fail.
The practical result is that this project runs, end to end, with model-written
prose, for no money.

### 5.5 Why the matching is not routed through a model

A model that is 97% right about a settlement is 3% wrong about a bank balance, and there
is no way to audit which 3%. Every decision in the engine is reproducible from the inputs
and the config, and a test asserts that the same input always produces the same decisions.

**Every failure path falls back to something deterministic** — no API key, a refusal, a
rate limit, a parse failure. Ingest falls back to the alias table, the notes and brief to
sentence templates, and the ask panel disables itself with a line saying the rest still
works. A reconciliation report with a blank reason column is worse than one written
stiffly.

---

## 5b. Baselines — what "good" is measured against

`eval/baselines.js` implements the two systems a merchant would plausibly have
instead. Both are scored by the same `evaluate()`, on the same datasets, against the
same ground truth, in the same process — so the comparison is not a story about two
different experiments.

**`spreadsheet`** — VLOOKUP the invoice amount against the bank statement within a
week. This is the honest floor and what finance teams actually do. It scores a **0.0%
match rate**, because Razorpay deducts a fee plus GST and batches a day of payments
into one credit, so the invoice amount is not a number that appears in the bank at all.

**`single_leg`** — match the invoice to a payment on amount and date, take the nearest
candidate when several fit, call it reconciled. No batch verification, no ambiguity
refusal, no check that the money reached the bank. This is not a straw man; it is what
a careful engineer builds on day one, before discovering how settlements work.

It is also the interesting one, because it **beats Recon on match rate** — 74.6% vs
55.6% on the hard profile — while booking ₹1.06 crore to the wrong place across ~2,900
invoices. Its two failure modes are exactly the two the engine is built to avoid:

1. picking one of several indistinguishable payments instead of escalating, and
2. declaring an invoice reconciled when the payout carrying it never reached the bank.

The design consequence: **a headline match rate rewards the wrong behaviour**, so the
metric this project optimises is precision, and the exception list is the product
rather than an apology for it. `metrics/compare_*.json` holds the raw output; the
dashboard renders it from `compare.json` next to the run it describes.

---

## 5c. Verification — the claims, checked

`npm run verify` exists because "deterministic" and "append-only" are assertions until
something tests them on the artefacts themselves:

| Check | What would be wrong if it failed |
|---|---|
| determinism | two runs of one input hash differently — nothing downstream is reproducible |
| audit completeness | a decision was made that never reached the trail |
| sequence density | a line was removed from the log |
| line validity | the log is corrupt and partially unreadable |
| value conservation | `matched + flagged ≠ invoiced` — a rupee was double-counted or lost |
| bucket exclusivity | a record is in neither state, or flagged with no reason code |
| single claim | one payment was booked against two invoices |
| ground truth | something auto-matched contradicts the answer key |

It exits non-zero on any failure, so it works in CI and in a demo. Deleting one line
from the middle of a 179-line audit log produces
`audit sequences are dense (no line removed) — run_… jumps to 42 at position 41`.
Both the passing and the tampered paths are tested by spawning the real CLI over real
files, so the check cannot quietly stop working.

---

## 6. Synthetic data and ground truth

The generator produces a merchant-month plus a `truth.json` stating the correct answer
for every record. Truth is derived from *how the data was built*, never from anything
the matcher does, and the engine never sees it.

Injected faults are **explicit counts, not probabilities** — "roughly three duplicates"
is not a testable statement. Each is arranged to test exactly one rule, controlled by
whether the gateway reference survives:

| Fault | Reference | Tests |
|---|---|---|
| sub-rupee drift | stripped | tolerant amount matching (A3) earns its keep |
| large keying typo | **kept** | a positively-identified row with a wrong amount is `amount_mismatch`, not unmatched |
| same amount + same day pair | stripped | the ambiguity guard refuses to guess |
| offline invoice | n/a | ledger row with no payment at all |
| unrecorded payment | n/a | captured money with no invoice behind it |
| late settlement | — | `date_out_of_window` |
| short credit | — | batch-level `amount_mismatch` |
| duplicate credit | — | `duplicate_utr` |
| **split credit** | — | *not a fault* — catches a matcher that assumes one UTR means one credit |
| orphan bank credit | — | money the gateway never sent |

Two profiles: `standard` (a normal month with an elevated fault rate) and `hard` (85%
of references stripped, payment lag up to 6 days — deliberately wider than the
matcher's own default window — split payouts, and every fault multiplied). The `hard`
profile exists because the generator and the matcher were written by the same hand:
clean numbers on friendly data prove nothing.

---

## 7. Known limitations

1. **The live Claude paths are unexercised** — no credentials on the build machine. All
   three model layers have only run through their deterministic fallbacks, or against
   stubbed clients in the test suite. The plumbing around each request is tested; no real
   call has been made.
2. **Standard-profile accuracy grades its own homework.** Generator and matcher share a
   spec; the hard-profile numbers are the honest ones.
3. **Refunds, chargebacks and partial captures are not modelled.** Bank debits are
   filtered out; only inbound settlement credits are reconciled. A refund netted off a
   settlement would currently surface as a batch `amount_mismatch` with a correct
   reason code but an incomplete explanation.
4. **On-hold and unsettled payments** are reported as `missing_counterpart` rather than
   getting a distinct "not yet settled" state.
5. **Single currency.** INR only; no FX.
6. **Calibration is one-dimensional** — it fits the ledger date window and nothing else.
   Amount tolerance and the bank window stay static.
7. **The live pull injects no amount/date collisions**, since real payment amounts
   cannot be forced to collide.
8. **Ingest maps columns; it does not clean rows.** Merged header rows, mid-file
   subtotals and repeated page footers will map correctly and then feed junk downstream.
   There is no row-level sanity pass.
9. **The ask agent has no answer-quality benchmark.** Its tools and loop are tested and
   it is structurally incapable of writing, but nothing scores whether its prose is
   *right*, the way `eval/score.js` scores the matcher. It is a faster way to read the
   exception list, not an independent check on it.
