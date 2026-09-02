import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHome, runCli } from './helpers.mjs';

const overlayPath = (home) => join(home, 'boot-safe', 'profiles', 'headless', 'disabled.patch.yml');
const statePath = (home) => join(home, 'boot-safe', 'profiles', 'headless', 'state.json');
const cfgPath = (home) => join(home, 'profiles', 'headless', 'cordis.patch.yml');
const overlayText = (home) => (existsSync(overlayPath(home)) ? readFileSync(overlayPath(home), 'utf-8') : '');
const disabledIds = (home) => JSON.parse(readFileSync(statePath(home), 'utf-8')).disabled;

test('unstable id (id-less entry): detected across attempts, cleaned up, richly reported', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const ok = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(ok.status, 0, ok.stderr); // last-known-good snapshot established
  appendFileSync(cfgPath(home), '# touch\n', 'utf-8'); // defeat the fast path

  const r = runCli(home, { mode: 'rotate-id', args: ['--profile', 'headless'] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /unstable id/, r.stderr);
  assert.match(r.stderr, /regenerated every boot/, r.stderr);
  assert.match(r.stderr, /does-not-matter\.mjs/, r.stderr);
  assert.match(r.stderr, /id: does-not-matter/, r.stderr); // suggested fix
  assert.match(r.stderr, /New since the last good boot/, r.stderr);
  assert.equal(overlayText(home), '', 'dead overlay entry removed');
  assert.deepEqual(disabledIds(home), [], 'state.disabled cleaned');
});

test('disable with no effect: ineffective entry removed and reported', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const r = runCli(home, { mode: 'no-effect', args: ['--profile', 'headless'] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not address this entry/, r.stderr);
  assert.equal(overlayText(home), '', 'ineffective overlay entry removed');
  assert.deepEqual(disabledIds(home), [], 'state.disabled cleaned');
});

test('never disables the config loader itself (include)', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const r = runCli(home, { mode: 'fail-include', args: ['--profile', 'headless'] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /config loader/, r.stderr);
  assert.ok(!overlayText(home).includes('include'), 'overlay must not disable include');
});

test('ids that are invalid unquoted YAML round-trip through the overlay', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const r = runCli(home, { mode: 'special-id-fail', args: ['--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(overlayText(home).includes('  - id: "@weird/pkg"\n'), overlayText(home));
});

test('plugin-enable removes a quoted overlay entry', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const r1 = runCli(home, { mode: 'special-id-fail', args: ['--profile', 'headless'] });
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = runCli(home, { args: ['safe', 'plugin-enable', '--profile', 'headless', '@weird/pkg'] });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(overlayText(home), '', 'quoted entry removed');
  assert.deepEqual(disabledIds(home), []);
});
