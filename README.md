# dsh-safe

| Check | Status |
|:---|:---:|
| **CI** | [![CI](https://github.com/wzwnolook/dsh-safe/actions/workflows/ci.yml/badge.svg)](https://github.com/wzwnolook/dsh-safe/actions) |
| **dsh latest** | [![dsh latest verified](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/wzwnolook/dsh-safe/main/.github/verified-dsh-version.json)](https://github.com/wzwnolook/dsh-safe/actions) |
| **dsh alpha** | [![dsh alpha verified](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/wzwnolook/dsh-safe/main/.github/verified-dsh-alpha-version.json)](https://github.com/wzwnolook/dsh-safe/actions) |

Requires **Node.js ^22.19 || >=24.0.0**.  Works with **dsh >= 0.1.0** (no source modification needed).

When a plugin misconfiguration or bad config causes dsh to fail on startup, `dsh-safe`
automatically detects the failure, disables the offending plugin or restores the previous
working configuration, so dsh starts again — all without modifying any dsh source code.

## Quick start

```bash
npm install -g @deepseek-ai/dsh-safe
echo 'alias dsh="dsh-safe"' >> ~/.zshrc && source ~/.zshrc  # you can also run dsh-safe directly
# PowerShell (Windows): add `Set-Alias dsh dsh-safe` to $PROFILE instead 

# One-time setup
dsh safe init
```

Verified on macOS and Linux. Windows is supported in code (spawns `dsh` through
`cmd.exe` to resolve npm's `.cmd` shim) but untested on a real Windows machine —
please report issues.

```bash
# Enable for your web profile (auto-enabled after init)
dsh safe activate --profile web

# Use it normally — boot-safe supervision is automatic
dsh web
```

## Commands

| Command | Effect |
|---|---|
| `dsh safe init` | One-time setup (boot-safe directory + minimal profile) |
| `dsh safe activate --profile <name>` | Enable auto-recovery for a profile |
| `dsh safe deactivate --profile <name>` | Pause auto-recovery |
| `dsh safe plugin-enable --profile <name> <id>` | Re-enable a disabled plugin |
| `dsh safe history [--profile <name>]` | View recovery log |
| `dsh web` | Start web profile with automatic supervision |
| `dsh --profile <name>` | Start any profile with automatic supervision |

## How it works

`dsh-safe` wraps `dsh` as a child process:

1. **Fingerprint check** — compares `cordis.patch.yml` and `package.json` hashes against last-known-good (a non-empty disable overlay always forces supervision)
2. **Unchanged → passthrough** — zero overhead, runs real `dsh` directly
3. **Changed → supervise** — spawns real `dsh` as child, monitors for a ready-signal file written by a tiny Cordis plugin (`ready.mjs`) injected via `--patch`; the plugin writes the signal only after the whole plugin tree has finished loading (the same condition dsh's own boot verdict uses), so a crash mid-load can never look like a success. A child that exits 0 without a ready signal is warned about and not recorded as a success. On success the fingerprints are recorded and the config is snapshotted as last-known-good
4. **Failure → disable** — extracts the failing entry id and name from stderr (the innermost `failed to import/apply loader entry <id> (<name>)` frame; falls back to a plugin `name → id` map via `--dump-config`), writes the id YAML-quoted to the `disabled.patch.yml` overlay, and retries. The config loader itself (`include`) is never disabled — its failures are reported with the root cause instead
5. **Repeated failure → classify** — a second observation of the same failure sorts it out: same name with a *changed* id means the config row has no stable id (the loader assigns a random one per boot), so the dead overlay entry is removed and the row is reported with file:line, root cause, and a suggested `id:` to add; same name with the *same* id means the overlay does not address the entry, so the ineffective entry is removed and reported
6. **YAML error → restore** — preserves the broken file under `versions/broken-<timestamp>/`, restores the last-known-good snapshot of `cordis.patch.yml`, and reports both paths; with no known-good snapshot it says so and exits 1 without touching the broken file
7. **Exhausted → hint** — suggests `dsh --profile minimal`

## Zero source modification

`dsh-safe` requires no patching of dsh. It works with any dsh version by:

- Using `dsh --profile <name> --dump-config` to build a plugin `name → id` map (instead of modifying dsh's error output)
- Using a tiny Cordis plugin (`ready.mjs`) injected via `--patch` to signal boot completion (instead of a ready-file hook in dsh)
- Implementing recovery logic in a standalone CLI wrapper

## Recovery location

All state is stored under `~/.dsh/boot-safe/`:

```
~/.dsh/
  boot-safe/
    profiles/<name>/
      state.json                 # attempts, disabled list, last-known-good hashes
      versions/<sha>/            # snapshots of cordis.patch.yml
      versions/broken-<ts>/      # broken configs preserved before a restore
      disabled.patch.yml         # auto-generated disable overrides (loaded via --patch)
    audit.log                    # full recovery history
  profiles/minimal/              # fallback profile (base bundle only)
```
