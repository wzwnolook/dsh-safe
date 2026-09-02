#!/usr/bin/env node

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, unlinkSync, rmdirSync, renameSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { argv, exit } from 'node:process';

const DSH = process.env.DSH_PATH || 'dsh';
// npm's global bin shim on Windows is dsh.cmd, which plain spawn cannot
// execute (EINVAL since Node's CVE-2024-27980 fix) — go through cmd.exe there.
// A DSH_PATH pointing at a real executable needs no shell on any platform.
// Engines floor 22.19 includes the .cmd argument-escaping fix.
const SPAWN_SHELL = process.platform === 'win32' && !process.env.DSH_PATH;
const BS = 'boot-safe';
const MAX_ATTEMPTS = 3;
const READY_TIMEOUT = 120_000;
// readyFile detection granularity on the supervised path; the file is written
// by ready.mjs only after the plugin tree settles, so polling cheapens latency
// without weakening the signal.
const READY_POLL_MS = 25;

function home() { return process.env.DSH_HOME || join(homedir(), '.dsh'); }
function absProfileDir(h, pf) { return join(h, 'profiles', pf); }
function configPath(h, pf) { return join(absProfileDir(h, pf), 'cordis.patch.yml'); }
function stateP(h, pf) { return join(h, BS, 'profiles', pf, 'state.json'); }
function versionsDir(h, pf) { return join(h, BS, 'profiles', pf, 'versions'); }
function disabledPatchP(h, pf) { return join(h, BS, 'profiles', pf, 'disabled.patch.yml'); }

// ---- deterministic helpers ----
function sha256File(f) {
  try { return createHash('sha256').update(readFileSync(f)).digest('hex'); }
  catch { return null; }
}

// ---- ANSI colors ----
const C = {
  red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
};
function clr(c, t) { return process.stderr.isTTY ? `${c}${t}${C.reset}` : t; }

function rptErr(label, err) {
  const m = err?.code || err?.message || String(err);
  process.stderr.write(`${clr(C.red, '[dsh-safe] error:')} ${label}: ${m}\n`);
}
function rptWarn(label, msg) {
  process.stderr.write(`${clr(C.yellow, '[dsh-safe] warning:')} ${label}: ${msg}\n`);
}

// ---- atomic JSON helpers ----
function atomicWriteJSON(p, d) {
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = p + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', 'utf-8');
  renameSync(tmp, p);
}

function defaultState() {
  return { enabled: true, attempts: 0, disabled: [], lastSha: null, lastBunSha: null };
}

/** Three-way state probe: 'ok' | 'missing' | 'corrupt' (state is a fresh default unless 'ok'). */
function probeState(h, pf) {
  const p = stateP(h, pf);
  if (!existsSync(p)) return { status: 'missing', state: defaultState() };
  let s = null;
  try { s = JSON.parse(readFileSync(p, 'utf-8')); } catch { /* corrupt */ }
  if (!s || typeof s !== 'object') return { status: 'corrupt', state: defaultState() };
  return { status: 'ok', state: s };
}

/** Defaults on missing; warn + defaults on corrupt (legacy callers only — prefer probeState). */
function readState(h, pf) {
  const probe = probeState(h, pf);
  if (probe.status === 'corrupt') {
    process.stderr.write(`${clr(C.yellow, '[dsh-safe] warning:')} state.json corrupt for "${pf}" — using defaults\n`);
  }
  return probe.state;
}

/** Management commands fail closed: a corrupt state file is never rewritten. */
function readStateForManage(h, pf) {
  const probe = probeState(h, pf);
  if (probe.status === 'corrupt') {
    process.stderr.write(`${clr(C.red, '[dsh-safe] error:')} state.json is corrupt — fix or remove it manually: ${stateP(h, pf)}\n`);
    exit(1);
  }
  return probe.state;
}

function writeState(h, pf, s) { atomicWriteJSON(stateP(h, pf), s); }

function audit(h, msg) {
  const f = join(h, BS, 'audit.log');
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, `[${new Date().toISOString()}] ${msg}\n`, { flag: 'a' });
}

// ---- Name → ID mapping ----
function buildNameIdMap(h, pf) {
  const map = new Map();
  const r = spawnSync(DSH, ['--profile', pf, '--dump-config'], {
    env: { ...process.env, DSH_HOME: h },
    encoding: 'utf-8', timeout: 30000, shell: SPAWN_SHELL,
  });
  if (r.error || r.status !== 0) {
    rptWarn('--dump-config', 'failed — falling back to plugin-name matching');
    return map;
  }
  let id = null, name = null;
  for (const line of r.stdout.split('\n')) {
    const a = line.match(/^\- id:\s*(\S+)/);
    if (a) {
      if (id && name) { map.set(id, id); map.set(name, id); }
      id = a[1]; name = null; continue;
    }
    const b = line.match(/^\s+name:\s+'?([^'\s]+)/);
    if (b && id) {
      name = b[1]; map.set(name, id); map.set(id, id);
      if (name.startsWith('@deepseek-ai/')) map.set(name.slice(14), id);
    }
  }
  if (id && name) { map.set(id, id); map.set(name, id); }
  return map;
}

function scrapeFailure(stderr) {
  // Real dsh loader failures name the entry id directly:
  // "failed to import loader entry <id> (<name>): ..." (also apply/dispose/rollback).
  // Boot errors nest causes ("failed to apply loader entry include (...):
  // failed to import loader entry <id> (...)"), so the LAST match in the text
  // is the innermost frame — the actual culprit, not a container like include.
  const re = /failed to (?:import|apply|dispose|rollback) loader entry ([\w./:@-]+)(?: \(([^)]*)\))?/g;
  let id = null, name = null;
  for (const m of stderr.matchAll(re)) { id = m[1]; name = m[2] || null; }
  if (id) return { id, name };
  const m = /^([\w@/-]+):\s*(?:Error|pending)/m.exec(stderr);
  return m ? { id: null, name: m[1] } : null;
}
function isYamlErr(stderr) {
  return stderr.includes('failed to parse') || stderr.includes('YAMLException');
}

// The composed dsh error line nests every frame: "... (<name>): <root cause>".
function rootCause(stderr) {
  const line = stderr.split('\n').find(l => l.trimStart().startsWith('Error'));
  if (!line) return stderr.trim().split('\n').pop() || '';
  const i = line.lastIndexOf('): ');
  return (i >= 0 ? line.slice(i + 3) : line).trim();
}

// Suggest an id for an id-less row: ./dir/mod.mjs → mod; @scope/pkg → pkg.
function suggestId(name) {
  const base = name.replace(/\.[cm]?[jt]s$/, '').split('/').pop() || name;
  return base.replace(/[^\w-]+/g, '-') || 'entry';
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function locateEntry(filePath, { id, name }) {
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    const idRe = id ? new RegExp(`^- id:\\s*"?${escRe(id)}"?\\s*$`) : null;
    let nameHit = null;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (idRe && idRe.test(t)) return `${filePath}:${i + 1}`;
      if (!nameHit && name && t.startsWith('name:') && t.includes(name)) nameHit = `${filePath}:${i + 1}`;
    }
    return nameHit;
  } catch {} // unreadable config → no location aid; the report works without it
  return null;
}

// ---- Disable overlay helpers ----
// Ids are written JSON-quoted: a JSON string is a valid YAML double-quoted
// scalar, so ids like "@scope/pkg" (a YAML reserved-indicator start) stay legal.
function doDisable(h, pf, id) {
  const f = disabledPatchP(h, pf);
  mkdirSync(join(f, '..'), { recursive: true });
  const old = existsSync(f) ? readFileSync(f, 'utf-8') : '';
  writeFileSync(f, old + `  - id: ${JSON.stringify(id)}\n    disabled: true\n`, 'utf-8');
}

function unquoteId(s) {
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch {} // malformed quoting → keep raw text
  }
  return s;
}

/** Parse disabled.patch.yml into a set of disabled ids (quoted or unquoted). */
function readDisabledIds(h, pf) {
  const f = disabledPatchP(h, pf);
  if (!existsSync(f)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    const m = line.match(/^\s+- id:\s*("(?:[^"\\]|\\.)*"|\S+)/);
    if (m) ids.add(unquoteId(m[1]));
  }
  return ids;
}

/** Rewrite disabled.patch.yml excluding one id. Uses YAML-aware parsing to avoid line-skip bugs. */
function undoDisable(h, pf, id) {
  const f = disabledPatchP(h, pf);
  if (!existsSync(f)) return;
  const ids = [];
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    const m = line.match(/^\s+- id:\s*("(?:[^"\\]|\\.)*"|\S+)/);
    if (m) ids.push(unquoteId(m[1]));
  }
  const filtered = ids.filter(i => i !== id);
  if (filtered.length === ids.length) return; // nothing removed
  writeFileSync(f, filtered.map(i => `  - id: ${JSON.stringify(i)}\n    disabled: true\n`).join(''), 'utf-8');
}

// Remove an overlay entry that demonstrably did nothing (the same failure
// recurred after disabling). Keeps disabled.patch.yml and state.json in sync.
function removeDisabled(h, pf, id) {
  try { undoDisable(h, pf, id); } catch (err) { rptWarn('disable overlay write', err); }
  try {
    const st = readState(h, pf);
    const i = st.disabled.indexOf(id);
    if (i >= 0) { st.disabled.splice(i, 1); writeState(h, pf, st); }
  } catch (err) { rptWarn('state update', err); }
}

// Best-effort provenance: was this row absent from the last-known-good config?
function newSinceGood(h, pf, name) {
  try {
    const st = readState(h, pf);
    if (!st.lastSha) return null;
    const dir = join(versionsDir(h, pf), st.lastSha);
    const snap = join(dir, 'cordis.patch.yml');
    if (!existsSync(snap)) return null;
    const had = readFileSync(snap, 'utf-8').includes(name);
    return { had, sha: st.lastSha.slice(0, 8), when: statSync(dir).mtime.toISOString().slice(0, 16).replace('T', ' ') };
  } catch { return null; } // no snapshot/state → no provenance line
}

// Shared detail lines for failure reports: config location, innermost cause,
// and whether the failing row is new since the last-known-good config.
function failureDetails(h, pf, fail, errText) {
  let s = '';
  const loc = locateEntry(configPath(h, pf), { id: fail?.id, name: fail?.name });
  if (loc) s += `\n  ${clr(C.dim, `File: ${loc}`)}`;
  const cause = rootCause(errText);
  if (cause) s += `\n  ${clr(C.dim, `Cause: ${cause}`)}`;
  const prov = fail?.name ? newSinceGood(h, pf, fail.name) : null;
  if (prov && !prov.had) s += `\n  ${clr(C.dim, `New since the last good boot (snapshot ${prov.sha}, ${prov.when}).`)}`;
  return s;
}

// The disable overlay provably did not address this entry (the identical
// failure recurred with the entry disabled). Clean up and report.
function reportIneffective(h, pf, id, fail, errText) {
  const label = fail?.name || id;
  process.stderr.write(
    `\n${C.bold}${C.red}[dsh-safe]${C.reset} ${clr(C.red, 'Boot failure detected:')}\n`
    + `  ${clr(C.cyan, label)} ${clr(C.dim, `(id: ${id})`)}`
    + failureDetails(h, pf, fail, errText)
    + `\n  ${clr(C.yellow, 'Action:')} the disable overlay did not address this entry — removed the ineffective entry.\n`
    + `  Fix it in your config, or try: ${clr(C.cyan, 'dsh --profile minimal')}\n`,
  );
  try { audit(h, `fail: profile ${pf} — disable ineffective for ${id}`); } catch (err) { rptWarn('audit', err); }
}

// ---- Snapshot/restore helpers ----
function snapshotConfig(h, pf) {
  const src = configPath(h, pf);
  const sha = sha256File(src);
  if (!sha) return null;
  const dir = join(versionsDir(h, pf), sha);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, join(dir, 'cordis.patch.yml'));
  }
  return sha;
}

function restoreConfig(h, pf, sha) {
  const src = join(versionsDir(h, pf), sha, 'cordis.patch.yml');
  const dest = configPath(h, pf);
  if (!existsSync(src)) return false;
  copyFileSync(src, dest);
  return true;
}

// Preserve the broken config before a restore overwrites it. Best-effort:
// recovery must not be blocked by a backup failure. Returns the backup dir.
function preserveBrokenConfig(h, pf) {
  const dir = join(versionsDir(h, pf), `broken-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(configPath(h, pf), join(dir, 'cordis.patch.yml'));
    return dir;
  } catch (err) { rptWarn('preserve broken config', err); return null; }
}

// ---- Minimal profile ----
function ensureMinimal(h) {
  const dir = join(h, 'profiles', 'minimal');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'package.json')))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-minimal', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }) + '\n');
  if (!existsSync(join(dir, 'cordis.patch.yml')))
    writeFileSync(join(dir, 'cordis.patch.yml'), '# Minimal profile\n[]\n');
}

// ---- Arg parsing ----
function findProfile(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--profile' || args[i] === '-p') && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith('--profile=')) return args[i].split('=', 2)[1];
  }
  // Positional subcommands: `dsh-safe web`, `dsh-safe headless`
  if (args[0] === 'web') return 'web';
  if (args[0] === 'headless') return 'headless';
  // `dsh-safe plugin <pnpm args>` — profile not detectable
  if (args[0] === 'plugin') return null;
  return 'default';
}

function passthrough(args) {
  const r = spawnSync(DSH, args, { stdio: 'inherit', env: { ...process.env, DSH_HOME: home() }, shell: SPAWN_SHELL });
  exit(r.status === null ? 1 : r.status);
}

// ---- Supervised child with ready signal ----
function runWithReadySignal(args, h) {
  return new Promise((resolve) => {
    const selfDir = fileURLToPath(new URL('..', import.meta.url));
    const readyPlugin = join(selfDir, 'ready.mjs');
    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-safe-'));
    const readyFile = join(tmpDir, 'ready');
    const patchFile = join(tmpDir, 'ready-patch.yml');
    writeFileSync(patchFile, `- insert:\n    - id: dsh-safe-ready\n      name: "${readyPlugin}"\n`, 'utf-8');

    const child = spawn(DSH, ['--patch', patchFile, ...args], {
      env: { ...process.env, DSH_HOME: h, DSH_SAFE_READY_FILE: readyFile },
      stdio: ['inherit', 'inherit', 'pipe'],
      shell: SPAWN_SHELL,
    });

    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });

    let settled = false;

    const poll = setInterval(() => {
      if (settled) return;
      if (existsSync(readyFile)) {
        settled = true; clearInterval(poll); child.unref();
        safeCleanup(tmpDir); resolve({ status: 0, stderr: '', ready: true });
      }
    }, READY_POLL_MS);

    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearInterval(poll);
      // A ready file is authoritative once written (the child may crash after
      // the tree settled — that is runtime scope, not a boot failure).
      if (existsSync(readyFile)) { safeCleanup(tmpDir); resolve({ status: 0, stderr: '', ready: true }); return; }
      safeCleanup(tmpDir); resolve({ status: code, stderr, ready: false });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true; clearInterval(poll); safeCleanup(tmpDir);
      process.stderr.write(`dsh-safe: spawn failed: ${err.message}\n`);
      resolve({ status: null, stderr: err.message });
    });

    setTimeout(() => {
      if (settled) return;
      settled = true; clearInterval(poll); child.kill('SIGTERM');
      safeCleanup(tmpDir); resolve({ status: null, stderr: 'timeout' });
    }, READY_TIMEOUT);
  });
}

function safeCleanup(dir) {
  try { unlinkSync(join(dir, 'ready')); } catch {}
  try { unlinkSync(join(dir, 'ready-patch.yml')); } catch {}
  try { rmdirSync(dir); } catch {}
}

// ---- Subcommands ----
function printUsage() {
  const lines = [
    '', 'Supervised dsh boot with auto-recovery from plugin failures.', '',
    '  alias dsh=dsh-safe', '  dsh safe <subcommand>  Manage boot-safe auto-recovery',
    '  dsh <args>             Normal dsh commands (supervised automatically)', '',
    'Subcommands:', '  safe init                               One-time setup',
    '  safe activate --profile <name>           Enable supervision',
    '  safe deactivate --profile <name>         Disable supervision',
    '  safe plugin-enable --profile <name> <id> Re-enable a disabled plugin',
    '  safe history [--profile <name>]          Show recovery log', '',
    'Environment:', '  DSH_PATH        Path to real dsh binary (default: "dsh")',
    '  DSH_HOME        dsh home directory (default: ~/.dsh)', '',
  ];
  for (const line of lines) process.stderr.write(line + '\n');
}

function safePassthrough(args) {
  const r = spawnSync(DSH, args, { stdio: 'inherit', env: process.env, shell: SPAWN_SHELL });
  return r.status ?? 1;
}

// ---- Main supervised boot function ----
async function safeSupervisedBoot(args, h, pf) {
  const s0 = readState(h, pf);

  // Normalize positional subcommands: `dsh-safe web` → `dsh --profile web`
  // so the --patch injected by runWithReadySignal doesn't conflict with Commander's subcommand parsing.
  const normalizedArgs = (args[0] === 'web' || args[0] === 'headless')
    ? ['--profile', args[0], ...args.slice(1)]
    : args;

  // ---- P0-2: Fingerprint fast path ----
  // Never take the fast path while a disabled overlay is non-empty: supervision
  // stays on until the user resolves the disabled plugins.
  const curSha = sha256File(configPath(h, pf));
  const curBunSha = sha256File(join(absProfileDir(h, pf), 'package.json'));
  if (
    s0.lastSha && s0.lastSha === curSha
    && (!curBunSha || s0.lastBunSha === curBunSha)
    && readDisabledIds(h, pf).size === 0
  ) {
    passthrough(normalizedArgs);
    return;
  }

  // Identity of the failure we disabled on the previous attempt. A second
  // observation of the same name classifies the failure (unstable id vs
  // ineffective disable) before another blind action.
  let prevFail = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const st = readState(h, pf);
      st.attempts = attempt;
      writeState(h, pf, st);
    } catch (err) { rptWarn('state update', err); }
    try { audit(h, `boot: profile ${pf} — attempt ${attempt}/${MAX_ATTEMPTS}`); } catch (err) { rptWarn('audit', err); }

    // P0-3: Recalculate overlay inside the loop so doDisable takes effect on next iteration
    const overlay = disabledPatchP(h, pf);
    const hasOverlay = existsSync(overlay);
    const childArgs = hasOverlay ? ['--patch', overlay, ...normalizedArgs] : normalizedArgs;

    let r;
    try {
      r = await runWithReadySignal(childArgs, h);
    } catch (err) {
      rptErr('supervisor setup — running without supervision', err);
      exit(safePassthrough(normalizedArgs));
      return;
    }

    if (r.status === 0 && r.ready === false) {
      // The child exited 0 without producing a ready signal: the observer
      // plugin died or the process drained before the tree settled. Boot state
      // is unknown — do not record success evidence (lastSha/snapshot/ok).
      process.stderr.write(
        `\n${C.bold}${C.yellow}[dsh-safe]${C.reset} ${clr(C.yellow, 'Child exited 0 without a ready signal — boot success not recorded.')}\n`
        + `  Supervision stays active for the next boot. If this repeats, report it.\n`,
      );
      try { audit(h, `fail: profile ${pf} — exited 0 without ready signal`); } catch (err) { rptWarn('audit', err); }
      exit(0);
      return;
    }

    if (r.status === 0) {
      try {
        const st = readState(h, pf);
        st.attempts = 0;
        st.lastSha = curSha;
        st.lastBunSha = curBunSha;
        writeState(h, pf, st);
      } catch (err) { rptWarn('state update', err); }
      // Snapshot only on success — this is the last-known-good definition.
      // snapshotConfig dedupes by content sha, so this is cheap.
      try { snapshotConfig(h, pf); } catch (err) { rptWarn('snapshot', err); }
      try { audit(h, `ok: profile ${pf} — boot succeeded`); } catch (err) { rptWarn('audit', err); }
      exit(0);
      return;
    }

    if (r.status === null) {
      try { audit(h, `fail: profile ${pf} — ${r.stderr || 'spawn error'}`); } catch (err) { rptWarn('audit', err); }
      exit(1);
      return;
    }

    const errText = r.stderr || '';

    // YAML error → restore the last-known-good snapshot recorded in state
    if (isYamlErr(errText)) {
      const cfgFile = configPath(h, pf);
      process.stderr.write(
        `\n${C.bold}${C.red}[dsh-safe]${C.reset} ${clr(C.red, 'YAML error in cordis.patch.yml')}\n`
        + `  File: ${cfgFile}\n`,
      );
      const st = readState(h, pf);
      if (st.lastSha) {
        const kept = preserveBrokenConfig(h, pf);
        if (restoreConfig(h, pf, st.lastSha)) {
          process.stderr.write(
            `  ${clr(C.yellow, 'Action:')} Restored last-known-good snapshot.\n`
            + (kept ? `  Broken copy preserved at: ${kept}\n` : ''),
          );
          try { audit(h, `restore: profile ${pf} — restored snapshot ${st.lastSha}${kept ? `, broken copy at ${kept}` : ''}`); } catch (err) { rptWarn('audit', err); }
          continue;
        }
      }
      process.stderr.write(`  ${clr(C.yellow, 'Action:')} No known-good snapshot available — fix the file manually.\n`);
      try { audit(h, `fail: profile ${pf} — yaml error, no snapshot to restore`); } catch (err) { rptWarn('audit', err); }
      exit(r.status);
      return;
    }

    // Identify the failing entry: the innermost loader-entry frame gives the
    // id directly; a bare name resolves through --dump-config.
    const fail = scrapeFailure(errText);
    const name = fail?.name || null;
    let id = fail?.id || null;
    if (!id && name) {
      const map = buildNameIdMap(h, pf);
      id = map.get(name) || name;
    }

    // A second observation of the same failure classifies it:
    //   same name, changed id → the row has no stable id (the loader assigns a
    //     random one per boot), so an id-targeted overlay can never address it;
    //   same name, same id → the disable overlay demonstrably had no effect.
    // Both converge on: remove the dead entry, report, exit.
    if (prevFail && fail && prevFail.name && prevFail.name === name) {
      removeDisabled(h, pf, prevFail.writtenId);
      if (prevFail.rawId !== fail.id) {
        process.stderr.write(
          `\n${C.bold}${C.red}[dsh-safe]${C.reset} ${clr(C.red, 'Boot failure detected:')}\n`
          + `  ${clr(C.cyan, name)} ${clr(C.dim, `(unstable id ${fail.id} — regenerated every boot)`)}`
          + failureDetails(h, pf, fail, errText)
          + `\n  ${clr(C.yellow, 'Action:')} no stable id — auto-disable is impossible. Add one or remove the row:\n`
          + `    - insert:\n        - id: ${suggestId(name)}   ${clr(C.dim, '← add this line')}\n          name: ${name}\n`,
        );
        try { audit(h, `fail: profile ${pf} — ${name} has no stable id`); } catch (err) { rptWarn('audit', err); }
      } else {
        reportIneffective(h, pf, prevFail.writtenId, fail, errText);
      }
      exit(r.status);
      return;
    }

    if (id === 'include') {
      // The config loader itself is not patch-addressable (an overlay row for
      // include is inert, verified against real dsh) — never write it.
      process.stderr.write(
        `\n${C.bold}${C.red}[dsh-safe]${C.reset} ${clr(C.red, 'Boot failure in the config loader (include):')}\n`
        + failureDetails(h, pf, fail, errText)
        + `\n  ${clr(C.yellow, 'Action:')} fix the config error above — the loader cannot be disabled.\n`,
      );
      try { audit(h, `fail: profile ${pf} — include is not disable-able`); } catch (err) { rptWarn('audit', err); }
      exit(r.status);
      return;
    }

    if (id && !readDisabledIds(h, pf).has(id)) {
      const cfgFile = configPath(h, pf);
      const loc = locateEntry(cfgFile, { id, name });
      const locLine = loc ? `\n  ${clr(C.dim, `File: ${loc}`)}` : '';
      process.stderr.write(
        `\n${C.bold}${C.red}[dsh-safe]${C.reset} ${clr(C.red, 'Boot failure detected:')}\n`
        + `  ${clr(C.cyan, name || id)} ${clr(C.dim, `(id: ${id})`)}${locLine}\n`
        + `  ${clr(C.yellow, 'Action:')} Disabled plugin. Fix then:\n`
        + `    ${clr(C.cyan, `dsh safe plugin-enable --profile ${pf} ${id}`)}\n`,
      );
      try { doDisable(h, pf, id); } catch (err) { rptWarn('disable overlay write', err); }
      try {
        const st = readState(h, pf);
        if (!st.disabled.includes(id)) st.disabled.push(id);
        writeState(h, pf, st);
      } catch (err) { rptWarn('state update', err); }
      try { audit(h, `disabled: profile ${pf} — ${id}`); } catch (err) { rptWarn('audit', err); }
      prevFail = { writtenId: id, rawId: fail?.id ?? null, name };
      continue; // retry with the disabled overlay
    }

    if (id) {
      // Disabled earlier (a previous run) yet still failing with the same
      // identity: the overlay does not address this entry.
      removeDisabled(h, pf, id);
      reportIneffective(h, pf, id, fail, errText);
      exit(r.status);
      return;
    }

    process.stderr.write(
      `\n${C.bold}${C.red}[dsh-safe]${C.reset} ${clr(C.red, 'Unknown boot failure.')}\n`
      + failureDetails(h, pf, fail, errText)
      + `\n  ${clr(C.yellow, 'Hint:')} Try: ${clr(C.cyan, 'dsh --profile minimal')}\n`,
    );
    try { audit(h, `fail: profile ${pf} — unknown failure`); } catch (err) { rptWarn('audit', err); }
    exit(r.status);
    return;
  }

  process.stderr.write(
    `\n${C.bold}${C.red}[dsh-safe]${C.reset} ${clr(C.red, 'Recovery exhausted.')}\n`
    + `  ${clr(C.yellow, 'Hint:')} Try: ${clr(C.cyan, 'dsh --profile minimal')}\n`,
  );
  exit(1);
}

// ---- Entry ----
async function main() {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage(); exit(0);
  }

  if (args[0] === 'safe') {
    const sub = args[1] || '';
    switch (sub) {
      case 'init': {
        const h = home();
        mkdirSync(join(h, BS), { recursive: true });
        ensureMinimal(h);
        for (const pf of ['web', 'headless']) {
          const s = readState(h, pf);
          s.enabled = true;
          writeState(h, pf, s);
        }
        audit(h, 'init: boot-safe installed');
        process.stderr.write('boot-safe initialised.\n  Alias: alias dsh=dsh-safe  (PowerShell: Set-Alias dsh dsh-safe)\n  Then: dsh safe activate --profile web\n  Then: dsh web\n');
        exit(0);
      }
      case 'activate': {
        const h = home();
        const pf = findProfile(args.slice(2));
        if (!pf) { process.stderr.write('error: --profile <name> required\n'); exit(1); }
        const s = readStateForManage(h, pf);
        s.enabled = true;
        writeState(h, pf, s);
        audit(h, `activate: profile ${pf}`);
        process.stderr.write(`boot-safe activated for "${pf}"\n`);
        exit(0);
      }
      case 'deactivate': {
        const h = home();
        const pf = findProfile(args.slice(2));
        if (!pf) { process.stderr.write('error: --profile <name> required\n'); exit(1); }
        const s = readStateForManage(h, pf);
        s.enabled = false;
        writeState(h, pf, s);
        audit(h, `deactivate: profile ${pf}`);
        process.stderr.write(`boot-safe deactivated for "${pf}"\n`);
        exit(0);
      }
      case 'plugin-enable': {
        const h = home();
        const pf = findProfile(args.slice(2));
        // P1-6: the id is the single positional argument — skip --profile/-p
        // (and its value) and --profile=*, regardless of argument order.
        const positional = [];
        const rest = args.slice(2);
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i];
          if (a === '--profile' || a === '-p') { i++; continue; }
          if (a.startsWith('--')) continue;
          positional.push(a);
        }
        const id = positional.length === 1 ? positional[0] : null;
        if (!pf || !id) { process.stderr.write('error: usage: dsh safe plugin-enable --profile <name> <id>\n'); exit(1); }
        const st = readStateForManage(h, pf);
        undoDisable(h, pf, id);
        try {
          const idx = st.disabled.indexOf(id);
          if (idx !== -1) st.disabled.splice(idx, 1);
          writeState(h, pf, st);
        } catch (err) { rptWarn('state update', err); }
        audit(h, `plugin-enable: profile ${pf} — ${id}`);
        process.stderr.write(`Re-enabled (id: ${id}). Restart dsh.\n`);
        exit(0);
      }
      case 'history': {
        const raw = args.slice(2);
        const pf = findProfile(raw);
        const hasPf = raw.includes('--profile');
        const h = home();
        try {
          const log = readFileSync(join(h, BS, 'audit.log'), 'utf-8');
          const lines = log.split('\n');
          const filtered = hasPf && pf ? lines.filter(l => l.includes(`profile ${pf}`)) : lines;
          process.stdout.write(filtered.join('\n') + '\n');
        } catch { process.stderr.write('No audit log.\n'); }
        exit(0);
      }
      default:
        process.stderr.write(`Unknown: dsh safe ${sub}\n`);
        exit(1);
    }
  }

  // ---- Supervised boot ----
  const h = home();
  const pf = findProfile(args);
  if (!pf || pf === 'default' && !existsSync(join(h, BS, 'profiles', 'default'))) {
    if (!existsSync(join(h, BS))) {
      rptWarn('not initialised', 'Run `dsh safe init` first, or use `dsh` directly.');
    }
    passthrough(args);
    return;
  }

  const bootDir = join(h, BS, 'profiles', pf);
  if (!existsSync(bootDir)) {
    passthrough(args);
    return;
  }

  // P1-7: fail closed — a missing or corrupt state means no supervision, and
  // the state file is never rewritten on a guess.
  const probe = probeState(h, pf);
  if (probe.status === 'corrupt') {
    rptWarn('state.json corrupt', `boot continues without supervision — fix or remove: ${stateP(h, pf)}`);
    passthrough(args);
    return;
  }
  if (probe.status === 'missing') {
    rptWarn('state.json missing', `profile "${pf}" is not supervised`);
    passthrough(args);
    return;
  }
  if (!probe.state.enabled) {
    passthrough(args);
    return;
  }

  await safeSupervisedBoot(args, h, pf);
  exit(0);
}

main();
