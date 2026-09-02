import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHome, runCli } from './helpers.mjs';

const OVERLAY = '  - id: some-id\n    disabled: true\n';

function seedOverlay(home) {
  const dir = join(home, 'boot-safe', 'profiles', 'headless');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'disabled.patch.yml');
  writeFileSync(f, OVERLAY, 'utf-8');
  return f;
}

test('accepts --profile=<name> <id> form', (t) => {
  const home = makeHome(t);
  const f = seedOverlay(home);
  const r = runCli(home, { args: ['safe', 'plugin-enable', '--profile=headless', 'some-id'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(f, 'utf-8'), '');
});

test('accepts <id> before --profile flag', (t) => {
  const home = makeHome(t);
  const f = seedOverlay(home);
  const r = runCli(home, { args: ['safe', 'plugin-enable', 'some-id', '--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(f, 'utf-8'), '');
});

test('missing id exits 1 with usage and does not touch the overlay', (t) => {
  const home = makeHome(t);
  const f = seedOverlay(home);
  const r = runCli(home, { args: ['safe', 'plugin-enable', '--profile', 'headless'] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
  assert.equal(readFileSync(f, 'utf-8'), OVERLAY);
});

test('a trailing flag is not accepted as id', (t) => {
  const home = makeHome(t);
  const f = seedOverlay(home);
  const r = runCli(home, { args: ['safe', 'plugin-enable', '--profile', 'headless', '--force'] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
  assert.equal(readFileSync(f, 'utf-8'), OVERLAY);
});
