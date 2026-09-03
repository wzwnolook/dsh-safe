/**
 * dsh-safe ready signal plugin.
 *
 * Writes the ready-signal file only once the plugin tree has genuinely
 * settled — the same condition dsh's own boot verdict uses (no loader import
 * or lifecycle tasks in flight; every enabled entry with a fiber is ACTIVE).
 * The signal therefore means "boot succeeded", not "this plugin applied".
 *
 * The condition is evaluated by read-only polling. Two tempting alternatives
 * were falsified against dsh 0.1.0-rc.7 and must not be reintroduced:
 * `loader.await()` called from a plugin strands the include fiber mid-apply
 * (loader reentrancy hazard) and turns a boot failure into a silent hang, and
 * `internal/status` never surfaces FAILED for loader import failures — the
 * rejection rides the entry init promise chain instead.
 *
 * On a failed boot dsh disposes the whole tree, this plugin included: the
 * poll stops on the inactive context and no signal is written. The wrapper
 * then owns failure handling (exit code + stderr identity). Never blocks dsh
 * boot — a write failure logs a warning through stderr and boot continues
 * without supervision.
 *
 * Activated by setting the `DSH_SAFE_READY_FILE` environment variable (the
 * dsh-safe CLI wrapper sets it before spawning the child process).
 *
 * @module @wzwnolook/dsh-safe/ready
 */

import { writeFileSync } from 'node:fs'

export const name = 'dsh-safe-ready'
export const inject = ['loader']

const FIBER_ACTIVE = 2
const POLL_MS = 10
/**
 * Consecutive settled polls required before signalling. The condition is
 * already safe to sample once — tree mutations only originate from in-flight
 * tasks, which `getTasks()` covers — so one confirmation poll is insurance,
 * not semantics. Keep the total window small: a one-shot child may call
 * `process.exit()` within ~100ms of settle (keyless credential failure), and
 * an explicit exit preempts pending timers.
 */
const STABLE_POLLS = 2

export function apply(ctx) {
  const readyFile = process.env.DSH_SAFE_READY_FILE
  if (!readyFile) return

  const settled = () => {
    if (ctx.loader.getTasks().length) return false
    for (const entry of ctx.loader.entries()) {
      if (entry.disabled || !entry.fiber) continue
      if (entry.fiber.state !== FIBER_ACTIVE) return false
    }
    return true
  }

  let stable = 0
  const timer = setInterval(() => {
    let ok
    try {
      ok = settled()
    } catch {
      // The context is inactive: boot failed and the tree is being disposed.
      clearInterval(timer)
      return
    }
    if (!ok) {
      stable = 0
      return
    }
    if (++stable < STABLE_POLLS) return
    clearInterval(timer)
    try {
      writeFileSync(readyFile, '', 'utf-8')
    } catch (err) {
      process.stderr.write(`[dsh-safe] warning: ready-signal write failed (${err.code || err.message}), continuing without supervision\n`)
    }
  }, POLL_MS)
  // The interval stays referenced until it concludes: this plugin only
  // activates under the supervising wrapper (DSH_SAFE_READY_FILE set), which
  // is waiting on exactly this signal. Unref'ing would let a fast-exiting
  // process (e.g. a keyless one-shot) drain the loop mid-window and exit 0
  // without the signal ever being written. A hung boot is still bounded by
  // the wrapper's READY_TIMEOUT kill. The timer is cleared on both exits
  // (ready written / context disposed), so it never outlives its purpose.
  ctx.effect(() => () => clearInterval(timer))
}
