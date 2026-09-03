#!/usr/bin/env node
// Read-only API over a reconciliation run.
//
// Deliberately thin: reconciliation happens in the CLI, which writes result.json
// and appends to audit.jsonl. The server just serves those files and the
// dashboard. That keeps the demo reproducible — what the judge sees on screen is
// the same artefact the metrics table was computed from, not a second code path
// that might disagree with it.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS } from './match/codes.js';
import { ask } from './agent/ask.js';
import { TOOL_DEFS } from './agent/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = resolve(repoRoot, process.env.RECON_DATA ?? 'data/demo');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(resolve(repoRoot, 'web')));

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const at = (name) => resolve(DATA_DIR, name);

function loadResult() {
  const path = at('result.json');
  if (!existsSync(path)) {
    const err = new Error(`no result.json in ${DATA_DIR} — run: npm run reconcile -- --data ${DATA_DIR}`);
    err.status = 404;
    throw err;
  }
  return readJSON(path);
}

// Re-read on every request rather than caching in memory: during a demo you
// re-run the CLI and refresh the page, and a stale in-process copy would show
// numbers that no longer match the files on disk.
const send = (handler) => (req, res) => {
  try {
    res.json(handler(req));
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
};

app.get('/api/summary', send(() => {
  const r = loadResult();
  return {
    dataset: r.dataset,
    summary: r.summary,
    throughput: r.throughput ?? null,
    explanations: r.explanations ?? null,
    brief: r.brief ?? null,
    calibrated_ledger_window: r.calibrated_ledger_window ?? null,
    config: r.config,
    finished_at: r.finished_at,
    metrics: existsSync(at('metrics.json')) ? readJSON(at('metrics.json')) : null,
    compare: existsSync(at('compare.json')) ? readJSON(at('compare.json')) : null,
    ingest: existsSync(at('ingest.json')) ? readJSON(at('ingest.json')) : null,
    agent: { available: Boolean(process.env.ANTHROPIC_API_KEY), tools: TOOL_DEFS.map((t) => t.name) },
  };
}));

app.get('/api/ledger', send((req) => {
  const r = loadResult();
  const { status, reason } = req.query;
  return r.ledger.filter((row) =>
    (!status || row.status === status) && (!reason || row.reason === reason));
}));

app.get('/api/exceptions', send(() => {
  const r = loadResult();
  // Ordered by what costs the merchant most: severity first, then value.
  const rank = { high: 0, medium: 1, low: 2, undefined: 3 };
  return [
    ...r.ledger.filter((l) => l.status === STATUS.EXCEPTION).map((l) => ({
      kind: 'invoice', id: l.invoice_id, date: l.date, counterparty: l.customer,
      amount_paise: l.ledger_amount, reason: l.reason, confidence: l.confidence,
      payment_id: l.payment_id, utr: l.utr, note: l.note ?? null, detail: l.detail,
    })),
    ...r.bank.filter((b) => b.status === STATUS.EXCEPTION && b.note).map((b) => ({
      kind: 'bank_credit', id: b.txn_id, date: b.date, counterparty: b.description,
      amount_paise: b.credit, reason: b.reason, confidence: 0,
      payment_id: null, utr: b.utr, note: b.note ?? null, detail: b.detail,
    })),
  ].sort((a, b) =>
    (rank[a.note?.severity] ?? 3) - (rank[b.note?.severity] ?? 3) || b.amount_paise - a.amount_paise);
}));

app.get('/api/settlements', send(() => loadResult().groups));

function readAudit(limit = Infinity) {
  const path = at('audit.jsonl');
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  return (Number.isFinite(limit) ? lines.slice(-limit) : lines).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

app.get('/api/audit', send((req) => {
  const path = at('audit.jsonl');
  if (!existsSync(path)) return { entries: [], total: 0 };
  const total = readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
  // Newest last in the file, so the tail is the most recent run.
  const entries = readAudit(Math.min(Number(req.query.limit ?? 200), 2000));
  return { entries, total, bytes: statSync(path).size };
}));

// The controller agent. POST because a question is not a resource, and because a
// question about a merchant's own books has no business sitting in a URL, a
// server log, or a browser history.
app.post('/api/ask', async (req, res) => {
  try {
    const question = String(req.body?.question ?? '').trim();
    if (!question) return res.status(400).json({ error: 'ask what?' });
    if (question.length > 2000) return res.status(400).json({ error: 'question too long' });

    const history = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
          .slice(-8)
      : [];

    const t0 = performance.now();
    const out = await ask(question, { result: loadResult(), audit: readAudit(4000), history });
    res.json({ ...out, elapsed_ms: Number((performance.now() - t0).toFixed(0)) });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\nRecon dashboard  http://localhost:${PORT}`);
  console.log(`  serving ${DATA_DIR}`);
  console.log(`  ask agent: ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off (set ANTHROPIC_API_KEY to enable)'}`);
  if (!existsSync(at('result.json'))) {
    console.log(`  (no result.json yet — run: npm run reconcile -- --data ${DATA_DIR})`);
  }
  console.log();
});
