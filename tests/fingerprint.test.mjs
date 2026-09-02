import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHome, runCli } from './helpers.mjs';

const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const cfgPath = (home) => join(home, 'profiles', 'headless', 'cordis.patch.yml');
const statePath = (home) => join(home, 'boot-safe', 'profiles', 'headless', 'state.json');
const init = (home) => runCli(home, { args: ['safe', 'init'] });

test('writes lastSha and lastBunSha after a successful supervised boot', (t) => {
  const home = makeHome(t);
  init(home);
  const r = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(readFileSync(statePath(home), 'utf-8'));
  assert.equal(st.lastSha, sha256(cfgPath(home)));
  assert.equal(st.lastBunSha, sha256(join(home, 'profiles', 'headless', 'package.json')));
});

test('identical second boot takes the fast path', (t) => {
  const home = makeHome(t);
  init(home);
  runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  const r2 = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.invocations.length > 0, 'stub was invoked');
  assert.ok(!r2.invocations.some(l => l.includes('--patch')), `fast path must not inject --patch: ${r2.invocations}`);
  assert.ok(!r2.invocations.some(l => l.includes('ready=1')), 'fast path must not inject DSH_SAFE_READY_FILE');
});

test('config change invalidates the fast path', (t) => {
  const home = makeHome(t);
  init(home);
  runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  appendFileSync(cfgPath(home), '# touched\n', 'utf-8');
  const r = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.invocations.some(l => l.includes('--patch')), 'expected supervised boot with --patch');
});

test('a non-empty disabled overlay blocks the fast path', (t) => {
  const home = makeHome(t);
  init(home);
  const r1 = runCli(home, { mode: 'plugin-fail', args: ['--profile', 'headless'] });
  assert.equal(r1.status, 0, r1.stderr); // auto-disable bad-plugin, then succeed
  const r2 = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.invocations.some(l => l.includes('--patch')), 'overlay must force supervised boot');
});
