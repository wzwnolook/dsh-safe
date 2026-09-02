import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHome, runCli } from './helpers.mjs';

const bsDir = (home) => join(home, 'boot-safe', 'profiles', 'headless');
const statePath = (home) => join(bsDir(home), 'state.json');

function seedCorrupt(home) {
  mkdirSync(bsDir(home), { recursive: true });
  writeFileSync(statePath(home), '{{{', 'utf-8');
}

test('corrupt state.json on boot falls back to passthrough and keeps the file', (t) => {
  const home = makeHome(t);
  seedCorrupt(home);
  const r = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.invocations.length > 0, 'stub was invoked');
  assert.ok(!r.invocations.some(l => l.includes('--patch')), 'must not supervise');
  assert.match(r.stderr, /corrupt/);
  assert.equal(readFileSync(statePath(home), 'utf-8'), '{{{', 'corrupt file untouched');
});

test('corrupt state.json blocks management commands', (t) => {
  const home = makeHome(t);
  seedCorrupt(home);
  const r = runCli(home, { args: ['safe', 'deactivate', '--profile', 'headless'] });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(statePath(home)), 'error names the state.json path');
  assert.equal(readFileSync(statePath(home), 'utf-8'), '{{{', 'corrupt file untouched');
});

test('missing state.json with existing boot dir is not supervised', (t) => {
  const home = makeHome(t);
  mkdirSync(bsDir(home), { recursive: true }); // boot dir without state.json
  const r = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.invocations.some(l => l.includes('--patch')), 'must passthrough');
});

test('atomic writes leave no temp files', (t) => {
  const home = makeHome(t);
  const r = runCli(home, { args: ['safe', 'activate', '--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  const leftovers = readdirSync(bsDir(home)).filter(f => f.includes('.tmp.'));
  assert.deepEqual(leftovers, []);
});
