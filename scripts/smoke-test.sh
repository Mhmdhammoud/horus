#!/usr/bin/env bash
# Horus install smoke test
#
# Verifies the built CLI artifact is runnable and outputs expected content.
# Does NOT require a live Postgres or source-intelligence backend.
#
# Usage:
#   ./scripts/smoke-test.sh                               # uses 'horus' on PATH
#   ./scripts/smoke-test.sh apps/horus/dist/index.cjs    # tests a local build

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${1:-}" ]; then
  TARGET="$1"
  if [[ "$TARGET" != /* ]]; then
    TARGET="$ROOT/$TARGET"
  fi
  HORUS=("node" "$TARGET")
else
  if ! command -v horus &>/dev/null; then
    printf '\n  ✗ horus not found on PATH\n\n' >&2
    exit 1
  fi
  HORUS=("horus")
fi

bold()  { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }

fail=0

# check_output: run HORUS with the given args, require the needle in stdout/stderr.
check_output() {
  local desc="$1" needle="$2"
  shift 2
  local out
  out="$("${HORUS[@]}" "$@" 2>&1 || true)"
  if printf '%s' "$out" | grep -qF -- "$needle"; then
    printf '  %s %s\n' "$(green '✓')" "$desc"
  else
    printf '  %s %s\n' "$(red '✗')" "$desc"
    printf '    expected: %s\n' "$needle"
    printf '    got:      %s\n' "$(printf '%s' "$out" | head -3)"
    fail=1
  fi
}

# check_exit0: run HORUS with the given args, require exit status 0.
check_exit0() {
  local desc="$1"
  shift
  if "${HORUS[@]}" "$@" >/dev/null 2>&1; then
    printf '  %s %s\n' "$(green '✓')" "$desc"
  else
    printf '  %s %s\n' "$(red '✗')" "$desc (non-zero exit)"
    fail=1
  fi
}

printf '\n  %s\n\n' "$(bold 'Horus smoke test')"

# --version: must exit 0, print "horus" and a semver
check_exit0   "--version exits 0"              --version
check_output  "--version shows horus"    "horus"       --version
check_output  "--version shows semver"   "0."          --version

# --help: must exit 0 and list core commands
check_exit0   "--help exits 0"                 --help
check_output  "--help lists investigate" "investigate" --help
check_output  "--help lists setup"       "setup"       --help
check_output  "--help lists index"       "index"       --help

# setup: must print the "Horus setup" header (prereqs may be absent — non-zero exit allowed)
check_output  "setup prints header"      "Horus setup" setup

# JS config loading: built binary must load config/horus.config.js without jiti/babel.cjs errors.
# Regression guard for HOR-83: previously failed with "Cannot find module '../dist/babel.cjs'".
JS_CONFIG="$ROOT/config/horus.config.js"
if [ -f "$JS_CONFIG" ]; then
  check_output  "JS config loads (no babel error)"  "Horus setup" setup --config "$JS_CONFIG"
  # Ensure the known regression string is absent
  out="$("${HORUS[@]}" setup --config "$JS_CONFIG" 2>&1 || true)"
  if printf '%s' "$out" | grep -qF 'babel.cjs'; then
    printf '  %s %s\n' "$(red '✗')" "JS config load: unexpected babel.cjs error"
    fail=1
  else
    printf '  %s %s\n' "$(green '✓')" "JS config load: no babel.cjs error"
  fi
else
  printf '  %s %s\n' "$(red '✗')" "JS config not found at $JS_CONFIG"
  fail=1
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '  %s\n\n' "$(green "$(bold 'PASS')")"
  exit 0
else
  printf '  %s\n\n' "$(red "$(bold 'FAIL')")"
  exit 1
fi
