import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHome, runCli } from './helpers.mjs';

const cfgPath = (home) => join(home, 'profiles', 'headless', 'cordis.patch.yml');
const auditPath = (home) => join(home, 'boot-safe', 'audit.log');
const GOOD = '# test profile\n[]\n';
const BAD = '# test profile\n# bad yaml\n- insert: [broken\n';

test('restores the last-known-good config on YAML error and then boots', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  assert.equal(readFileSync(cfgPath(home), 'utf-8'), GOOD, 'fixture sanity');
  const ok = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(ok.status, 0, ok.stderr); // establishes last-known-good snapshot

  writeFileSync(cfgPath(home), BAD, 'utf-8');
  const r = runCli(home, { mode: 'yaml-if-bad', args: ['--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(cfgPath(home), 'utf-8'), GOOD, 'config restored byte-for-byte');
  assert.match(readFileSync(auditPath(home), 'utf-8'), /restore/);
});

test('preserves the broken config under versions/ before restoring', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  const ok = runCli(home, { mode: 'ok', args: ['--profile', 'headless'] });
  assert.equal(ok.status, 0, ok.stderr); // establishes last-known-good snapshot

  writeFileSync(cfgPath(home), BAD, 'utf-8');
  const r = runCli(home, { mode: 'yaml-if-bad', args: ['--profile', 'headless'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(cfgPath(home), 'utf-8'), GOOD, 'config restored byte-for-byte');
  const m = r.stderr.match(/^ +Broken copy preserved at: (.+)$/m);
  assert.ok(m, `stderr reports the preserved location:\n${r.stderr}`);
  assert.match(m[1], /versions[/\\]broken-/, 'preserved under versions/broken-*');
  assert.equal(readFileSync(join(m[1], 'cordis.patch.yml'), 'utf-8'), BAD, 'broken config preserved byte-for-byte');
});

test('without a known-good snapshot, exits 1 without touching the broken config', (t) => {
  const home = makeHome(t);
  runCli(home, { args: ['safe', 'init'] });
  writeFileSync(cfgPath(home), BAD, 'utf-8');
  const r = runCli(home, { mode: 'yaml-if-bad', args: ['--profile', 'headless'] });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(cfgPath(home), 'utf-8'), BAD, 'broken config left as-is');
  assert.ok(!r.stderr.includes('Restored'), 'must not falsely report a restore');
});
