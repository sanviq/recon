#!/usr/bin/env node
//   node server/src/cli/ask.js --data data/demo "how much money is stuck and who do I chase first?"
//   node server/src/cli/ask.js --data data/demo            (interactive)
//
// The same agent the dashboard uses, from a terminal. Prints the tool calls it
// made before the answer, because "which records did that come from" is the only
// question worth asking about an answer a model wrote.

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ask } from '../agent/ask.js';
import { parseArgs } from './args.js';

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(process.cwd(), args.data ?? 'data/demo');
const resultPath = resolve(dataDir, 'result.json');

if (!existsSync(resultPath)) {
  console.error(`no result.json in ${dataDir} — run: npm run reconcile -- --data ${dataDir}`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. The agent needs a key; everything else in Recon does not.');
  process.exit(1);
}

const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const auditPath = resolve(dataDir, 'audit.jsonl');
const audit = existsSync(auditPath)
  ? readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    })
  : [];

const history = [];

async function run(question) {
  const t0 = performance.now();
  const out = await ask(question, { result, audit, history });

  for (const t of out.trace) {
    const arg = Object.entries(t.input ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    console.log(`  · ${t.tool}${arg ? `(${arg})` : '()'}${t.rows !== null ? ` -> ${t.rows} rows` : ''}${t.error ? ` !! ${t.error}` : ''}`);
  }
  console.log(`\n${out.answer}\n`);
  console.log(`  [${out.trace.length} tool call(s), ${out.iterations} turn(s), ${(performance.now() - t0).toFixed(0)}ms, ` +
              `${out.usage.input_tokens} in / ${out.usage.output_tokens} out, ${out.usage.cache_read_input_tokens} cached]\n`);

  history.push({ role: 'user', content: question }, { role: 'assistant', content: out.answer });
}

const inline = args._?.join(' ').trim();
if (inline) {
  await run(inline);
  process.exit(0);
}

console.log(`\nAsk the reconciliation in ${dataDir}. Ctrl-C to quit.`);
console.log('  try: "how much money is stuck, and who do I chase first?"\n');
const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const q = (await rl.question('> ')).trim();
  if (!q) continue;
  if (q === 'exit' || q === 'quit') break;
  console.log();
  try {
    await run(q);
  } catch (err) {
    console.error(`  error: ${err.message}\n`);
  }
}
rl.close();
