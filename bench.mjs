#!/usr/bin/env node
/**
 * Startup-time benchmark for dsh-safe against an installed dsh.
 *
 * Scenarios (keyless, scratch DSH_HOME):
 *   vanilla-exit    real dsh to process exit (baseline; includes the post-boot
 *                   keyless credential failure a few ms after boot)
 *   vanilla-settle  real dsh + ready.mjs injected directly, time to ready file
 *                   (true time-to-boot-complete without the wrapper)
 *   fast-path       dsh-safe with matching fingerprints (passthrough)
 *   supervised      dsh-safe with the config touched per run (forces the
 *                   supervised path: ready signal, fingerprint, snapshot)
 *
 * Usage: node bench.mjs [runs=6]   (DSH_PATH overrides the dsh binary)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const RUNS = Number(process.argv[2]) || 6
const DSH = process.env.DSH_PATH || 'dsh'
const PKG = dirname(fileURLToPath(import.meta.url))
const CLI = join(PKG, 'bin', 'dsh-safe.mjs')

const W = mkdtempSync(join(tmpdir(), 'dsh-bench-'))
const H = join(W, 'home')
mkdirSync(H, { recursive: true })
const env = { ...process.env, DSH_HOME: H }

const cfg = () => join(H, 'profiles', 'headless', 'cordis.patch.yml')
const touchCfg = (tag) => appendFileSync(cfg(), `# bench ${tag} ${performance.now()}\n`)

function run(cmd, envExtra) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const p = spawn(cmd[0], cmd.slice(1), { env: { ...env, ...envExtra }, stdio: 'ignore' })
    p.on('close', () => resolve((performance.now() - t0) / 1000))
  })
}

function runUntilFile(cmd, watch, envExtra) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const p = spawn(cmd[0], cmd.slice(1), { env: { ...env, ...envExtra }, stdio: 'ignore' })
    const poll = setInterval(() => {
      if (existsSync(watch)) {
        clearInterval(poll)
        const dt = (performance.now() - t0) / 1000
        p.kill('SIGTERM')
        setTimeout(() => resolve(dt), 50)
      } else if (p.exitCode !== null) {
        clearInterval(poll)
        resolve(null) // exited without producing the signal
      }
    }, 2)
  })
}

const stats = (ts) => {
  const ok = ts.filter((t) => t !== null)
  if (!ok.length) return 'all runs failed (no signal)'
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length
  return `avg ${avg.toFixed(3)}s  min ${Math.min(...ok).toFixed(3)}s  max ${Math.max(...ok).toFixed(3)}s  (n=${ok.length}/${ts.length})`
}
const mean = (ts) => ts.filter((t) => t !== null).reduce((a, b, _, a2) => a + b / a2.length, 0)

try {
  // Setup: materialize the headless profile (keyless failure is expected),
  // reset the patch, init + activate boot-safe.
  await run([DSH, '--profile', 'headless', 'echo ok'])
  writeFileSync(cfg(), '[]\n')
  await run(['node', CLI, 'safe', 'init'])
  await run(['node', CLI, 'safe', 'activate', '--profile', 'headless'])

  // Probe patch injecting this package's own ready.mjs without the wrapper.
  const probePatch = join(W, 'probe-patch.yml')
  writeFileSync(probePatch, `- insert:\n    - id: dsh-safe-ready\n      name: "${join(PKG, 'ready.mjs')}"\n`)

  const results = {}

  console.error('[supervised]')
  results.supervised = []
  for (let i = 0; i < RUNS; i++) {
    touchCfg(i)
    results.supervised.push(await run(['node', CLI, '--profile', 'headless', 'echo ok']))
  }

  console.error('[fast-path]')
  results['fast-path'] = []
  for (let i = 0; i < RUNS; i++) results['fast-path'].push(await run(['node', CLI, '--profile', 'headless', 'echo ok']))

  console.error('[vanilla-exit]')
  results['vanilla-exit'] = []
  for (let i = 0; i < RUNS; i++) results['vanilla-exit'].push(await run([DSH, '--profile', 'headless', 'echo ok']))

  console.error('[vanilla-settle]')
  results['vanilla-settle'] = []
  for (let i = 0; i < RUNS; i++) {
    const rf = join(W, `ready-${i}`)
    results['vanilla-settle'].push(await runUntilFile(
      [DSH, '--patch', probePatch, '--profile', 'headless', 'echo ok'], rf, { DSH_SAFE_READY_FILE: rf }))
  }

  console.log('\n===== SUMMARY =====')
  for (const k of ['vanilla-exit', 'vanilla-settle', 'fast-path', 'supervised']) {
    console.log(`  ${k.padEnd(15)} ${stats(results[k])}`)
  }
  const [ve, vs, fp, s] = [mean(results['vanilla-exit']), mean(results['vanilla-settle']), mean(results['fast-path']), mean(results.supervised)]
  console.log(`\n  wrapper detection latency:  supervised - vanilla-settle = ${(s - vs).toFixed(3)}s`)
  console.log(`  fast-path cost vs vanilla:  fast-path - vanilla-exit    = ${(fp - ve).toFixed(3)}s`)
} finally {
  rmSync(W, { recursive: true, force: true })
}
