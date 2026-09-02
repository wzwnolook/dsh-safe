import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../bin/dsh-safe.mjs', import.meta.url));
export const FAKE_DSH = fileURLToPath(new URL('fixtures/fake-dsh', import.meta.url));

/** Create a throwaway DSH_HOME with a preset headless profile. */
export function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-safe-test-'));
  const prof = join(home, 'profiles', 'headless');
  mkdirSync(prof, { recursive: true });
  writeFileSync(join(prof, 'cordis.patch.yml'), '# test profile\n[]\n', 'utf-8');
  writeFileSync(join(prof, 'package.json'), JSON.stringify({ name: 'dsh-profile-headless', private: true, dependencies: {} }) + '\n', 'utf-8');
  t.after(() => { rmSync(home, { recursive: true, force: true }); });
  return home;
}

/**
 * Run the dsh-safe CLI against the fake dsh stub.
 * Returns { status, stdout, stderr, invocations } where invocations are the
 * stub log lines recorded during this run only.
 */
export function runCli(home, { mode = 'ok', args = [] } = {}) {
  const fakeLog = join(home, 'fake-dsh.log');
  writeFileSync(fakeLog, '', 'utf-8');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PATH: FAKE_DSH,
      FAKE_MODE: mode,
      FAKE_LOG: fakeLog,
    },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  const invocations = readFileSync(fakeLog, 'utf-8').split('\n').filter(Boolean);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, invocations };
}
