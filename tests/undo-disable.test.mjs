import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHome, runCli } from './helpers.mjs';

const OVERLAY = '  - id: a\n    disabled: true\n  - id: b\n    disabled: true\n  - id: c\n    disabled: true\n';

function seedOverlay(home, content = OVERLAY) {
  const dir = join(home, 'boot-safe', 'profiles', 'headless');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'disabled.patch.yml');
  writeFileSync(f, content, 'utf-8');
  return f;
}

test('plugin-enable removes only the target id and keeps valid YAML', (t) => {
  const home = makeHome(t);
  const f = seedOverlay(home);
  const r = runCli(home, { args: ['safe', 'plugin-enable', '--profile', 'headless', 'b'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(f, 'utf-8'), '  - id: "a"\n    disabled: true\n  - id: "c"\n    disabled: true\n');
});

test('plugin-enable with an id that is not present leaves the file untouched', (t) => {
  const home = makeHome(t);
  const f = seedOverlay(home);
  const r = runCli(home, { args: ['safe', 'plugin-enable', '--profile', 'headless', 'zzz'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(f, 'utf-8'), OVERLAY);
});
