import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The verifier is the thing that turns "append-only audit trail" from a sentence
// in the README into something a judge can run. So it is tested the way it is
// used: as a process, over real files on disk.

const here = dirname(fileURLToPath(import.meta.url));
const cli = (name) => resolve(here, '../src/cli', name);
const repoRoot = resolve(here, '../..');
const run = (script, args) => spawnSync(process.execPath, [cli(script), ...args], { cwd: repoRoot, encoding: 'utf8' });

function freshRun() {
  const dir = mkdtempSync(resolve(tmpdir(), 'recon-verify-'));
  const gen = run('generate.js', ['--seed', '4242', '--out', dir]);
  assert.equal(gen.status, 0, gen.stderr);
  const rec = run('reconcile.js', ['--data', dir]);
  assert.equal(rec.status, 0, rec.stderr);
  return dir;
}

test('a clean run passes every check', () => {
  const dir = freshRun();
  try {
    const out = run('verify.js', ['--data', dir]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, /FAIL/);
    assert.match(out.stdout, /determinism/);
    assert.match(out.stdout, /checks passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The claim is that the audit trail is evidence, which is only true if removing a
// line is detectable. If this test ever passes silently, the claim is marketing.
test('removing a single audit line is detected and located', () => {
  const dir = freshRun();
  try {
    const path = resolve(dir, 'audit.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length > 50, 'need enough lines for the removal to be mid-file');
    lines.splice(40, 1);
    writeFileSync(path, lines.join('\n') + '\n');

    const out = run('verify.js', ['--data', dir]);
    assert.equal(out.status, 1, 'a tampered log must fail the run, not just warn');
    assert.match(out.stdout, /FAIL {2}audit sequences are dense/);
    assert.match(out.stdout, /jumps to 42 at position 41/, 'and it must say where');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupted audit line is caught rather than silently skipped', () => {
  const dir = freshRun();
  try {
    const path = resolve(dir, 'audit.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    lines[10] = '{ this is not json';
    writeFileSync(path, lines.join('\n') + '\n');

    const out = run('verify.js', ['--data', dir]);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /FAIL {2}every audit line is valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the whole demo runs end to end without a key', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'recon-demo-'));
  try {
    const out = spawnSync(process.execPath, [cli('demo.js'), '--seed', '11', '--data', dir],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    assert.equal(out.status, 0, out.stdout.slice(-2000) + out.stderr);
    assert.match(out.stdout, /checks passed/, 'verify ran');
    assert.match(out.stdout, /precision \(auto-matched\)/, 'evaluate ran');
    assert.match(out.stdout, /single_leg/, 'compare ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
