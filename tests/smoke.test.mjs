import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHome, runCli } from './helpers.mjs';

test('init creates boot-safe dir and minimal profile', (t) => {
  const home = makeHome(t);
  const r = runCli(home, { args: ['safe', 'init'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, 'boot-safe')), 'boot-safe dir');
  assert.ok(existsSync(join(home, 'profiles', 'minimal', 'package.json')), 'minimal package.json');
  assert.ok(existsSync(join(home, 'profiles', 'minimal', 'cordis.patch.yml')), 'minimal cordis.patch.yml');
});

test('activate writes state', (t) => {
  const home = makeHome(t);
  const r = runCli(home, { args: ['safe', 'activate', '--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(readFileSync(join(home, 'boot-safe', 'profiles', 'headless', 'state.json'), 'utf-8'));
  assert.equal(st.enabled, true);
});

test('ok mode boot exits 0 under supervision', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const r = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    r.invocations.some(l => l.includes('ready=1')),
    'expected a supervised invocation with DSH_SAFE_READY_FILE set',
  );
});
