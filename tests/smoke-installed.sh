#!/usr/bin/env bash
# Real-dsh smoke for dsh-safe (acceptance gate; keyless).
# Requires an installed dsh (DSH_PATH, default: `command -v dsh`). Uses a
# scratch DSH_HOME. Profile 'headless' is materialized by real dsh first (a
# hand-seeded base-bundle profile has no one-shot app and blocks on stdin).
#
# Scenarios:
#   2. first supervised boot records lastSha
#   3. second identical boot takes the fast path (no new boot audit line)
#   4. unparseable YAML -> last-known-good restore (byte-for-byte) + exit 0
#   5. malformed patch entry (id without name) -> auto-disable + exit 0
#   6. ghost plugin module -> auto-disable + exit 0
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$SELF_DIR/bin/dsh-safe.mjs"
DSH_BIN="${DSH_PATH:-$(command -v dsh || true)}"
if [ -z "$DSH_BIN" ]; then echo "no dsh found; set DSH_PATH" >&2; exit 2; fi

W=$(mktemp -d /tmp/dsh-smoke-XXXXXX)
H=$W/home
mkdir -p "$H" "$W/logs"
trap 'rm -rf "$W"' EXIT
export DSH_HOME="$H" DSH_PATH="$DSH_BIN"

FAILS=0
check() { # check <label> <0-on-pass>
  if [ "$2" -eq 0 ]; then echo "PASS: $1"; else echo "FAIL: $1"; FAILS=$((FAILS + 1)); fi
}

bounded() { # bounded <seconds> <cmd...>
  local secs="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) &
  local watcher=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return $rc
}

echo "=== 0. materialize headless profile (keyless run; failure expected) ==="
bounded 180 "$DSH_BIN" --profile headless "echo ok" >"$W/logs/materialize.log" 2>&1
echo "materialize exit=$? (non-zero acceptable)"
[ -f "$H/profiles/headless/cordis.patch.yml" ]
check "profile materialized" $?
printf '[]\n' > "$H/profiles/headless/cordis.patch.yml"
cp "$H/profiles/headless/cordis.patch.yml" "$W/good.ref"

dsf() { node "$CLI" "$@"; }

echo "=== 1. init + activate ==="
dsf safe init >/dev/null 2>&1
dsf safe activate --profile headless >/dev/null 2>&1
check "init + activate" $?

echo "=== 2. first supervised boot ==="
bounded 300 dsf --profile headless "echo ok" >"$W/logs/b1.log" 2>&1
rc=$?
grep -q '"lastSha": "[a-f0-9]\{64\}"' "$H/boot-safe/profiles/headless/state.json"
check "first boot exit 0 ($rc) + lastSha written" $?

echo "=== 3. second boot takes the fast path ==="
before=$(grep -c 'boot: profile headless' "$H/boot-safe/audit.log" || true)
bounded 300 dsf --profile headless "echo ok" >"$W/logs/b2.log" 2>&1 || true
after=$(grep -c 'boot: profile headless' "$H/boot-safe/audit.log" || true)
[ "$before" = "$after" ]
check "fast path (audit boot lines $before -> $after)" $?

echo "=== 4. unparseable YAML -> restore ==="
printf -- '- insert:\n  - id: broken\n    name: [unclosed\n\tbad-indent\n' > "$H/profiles/headless/cordis.patch.yml"
bounded 300 dsf --profile headless "echo ok" >"$W/logs/b3.log" 2>&1
rc=$?
grep -q 'Restored last-known-good snapshot' "$W/logs/b3.log" \
  && diff -q "$W/good.ref" "$H/profiles/headless/cordis.patch.yml" >/dev/null
check "restore path exit 0 ($rc) + config byte-for-byte" $?

echo "=== 5. malformed patch entry -> auto-disable ==="
printf -- '- insert:\n  - id: test\n  name: bad-indent\n' > "$H/profiles/headless/cordis.patch.yml"
bounded 300 dsf --profile headless "echo ok" >"$W/logs/b4.log" 2>&1
rc=$?
grep -q '^  - id: "test"$' "$H/boot-safe/profiles/headless/disabled.patch.yml"
check "malformed entry disabled + exit 0 ($rc)" $?

echo "=== 6. ghost plugin module -> auto-disable ==="
printf -- '- insert:\n  - id: ghost-plugin\n    name: ./does-not-exist-anywhere.mjs\n' > "$H/profiles/headless/cordis.patch.yml"
bounded 300 dsf --profile headless "echo ok" >"$W/logs/b5.log" 2>&1
rc=$?
grep -q '^  - id: "ghost-plugin"$' "$H/boot-safe/profiles/headless/disabled.patch.yml" \
  && grep -q 'ok: profile headless' "$H/boot-safe/audit.log"
check "ghost plugin disabled + recovery succeeded ($rc)" $?

echo
if [ "$FAILS" -eq 0 ]; then echo "smoke: all scenarios passed"; else echo "smoke: $FAILS scenario(s) FAILED (logs under $W kept on failure)"; trap - EXIT; exit 1; fi
