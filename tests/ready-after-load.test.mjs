import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHome, runCli } from './helpers.mjs';

// Task 7: the ready signal must mean "plugin tree settled" (boot's own success
// condition), and a child that exits 0 without any ready signal must not be
// recorded as a successful boot. See TODO-FIXES.md Task 7 and the rc.7 spike
// findings recorded there.

test('import failure in real dsh stderr format auto-disables the plugin and retries', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const r = runCli(home, { mode: 'import-fail', args: ['--profile', 'headless', 'echo ok'] });
  assert.equal(r.status, 0, `expected recovery success, stderr: ${r.stderr}`);
  const overlay = readFileSync(join(home, 'boot-safe', 'profiles', 'headless', 'disabled.patch.yml'), 'utf-8');
  assert.match(overlay, /id: "bad-plugin"/);
  const auditLog = readFileSync(join(home, 'boot-safe', 'audit.log'), 'utf-8');
  assert.match(auditLog, /disabled: profile headless — bad-plugin/);
  // The first attempt failed; recovery succeeded on retry.
  assert.match(auditLog, /ok: profile headless — boot succeeded/);
});

test('exit 0 without a ready signal records no success evidence', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const r = runCli(home, { mode: 'no-ready-ok', args: ['--profile', 'headless', 'echo ok'] });
  assert.equal(r.status, 0, `child exited 0, wrapper follows, stderr: ${r.stderr}`);
  assert.match(r.stderr, /without (a )?ready signal/i);
  const auditPath = join(home, 'boot-safe', 'audit.log');
  const auditLog = existsSync(auditPath) ? readFileSync(auditPath, 'utf-8') : '';
  assert.doesNotMatch(auditLog, /^.*ok: profile headless.*$/m);
  const state = JSON.parse(readFileSync(join(home, 'boot-safe', 'profiles', 'headless', 'state.json'), 'utf-8'));
  assert.ok(!state.lastSha, 'lastSha must not be written without a ready signal');
  assert.equal(existsSync(join(home, 'boot-safe', 'profiles', 'headless', 'versions')), false, 'no last-known-good snapshot without a ready signal');
});

test('a ready signal followed by an immediate child crash is still a success (post-settle crashes are runtime scope)', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const r = runCli(home, { mode: 'ready-then-crash', args: ['--profile', 'headless', 'echo ok'] });
  assert.equal(r.status, 0, `ready file is authoritative once written, stderr: ${r.stderr}`);
  const auditLog = readFileSync(join(home, 'boot-safe', 'audit.log'), 'utf-8');
  assert.match(auditLog, /ok: profile headless — boot succeeded/);
});
