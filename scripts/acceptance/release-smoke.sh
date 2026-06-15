#!/usr/bin/env bash
# HOR-52 — Curl-installed Horus release smoke test
#
# Validates the public curl-installed release path end-to-end.
# This script is the repeatable release acceptance check for the exact path
# a new user runs. It does NOT duplicate the unit/process-level CLI tests
# from HOR-49 (smoke-test.sh handles those).
#
# Usage:
#   ./scripts/acceptance/release-smoke.sh            # assumes horus is on PATH
#   ./scripts/acceptance/release-smoke.sh --install  # curl-installs first, then verifies
#
# Environment variables:
#   INSTALL_URL            override the installer URL (default: https://horus.sh/install.sh)
#   HORUS_BIN              path to horus binary (overrides PATH lookup)
#   HORUS_INSTALL_UNSAFE=1 bypass the existing-binary safety check in --install mode
#
# Isolation note:
#   --install mode aborts if /usr/local/bin/horus or ~/.local/bin/horus already exists,
#   to avoid overwriting a developer's live binary. Run in a fresh container instead:
#     docker run --rm ubuntu:22.04 bash -c \
#       'apt-get install -y curl nodejs && curl -fsSL https://horus.sh/install.sh | bash && horus --version'
#
# Expected output (all lines should show ✓):
#   ✓ curl install exited 0                        (--install only)
#   ✓ installer output does not identify product as Axon  (--install only)
#   ✓ horus is on PATH
#   ✓ --version exits 0
#   ✓ --version shows "horus" (not Axon)
#   ✓ --version shows semver
#   ✓ --help exits 0
#   ✓ --help lists investigate
#   ✓ --help lists setup
#   ✓ --help lists index
#   ✓ --help lists connect
#   ✓ --help usage line names product 'horus'
#   ✓ setup --help exits 0
#   ✓ index --help exits 0
#   ✓ investigate --help exits 0
#   ✓ connect --help exits 0
#   ✓ hosts --help exits 0
#   ✓ stop --help exits 0
#
# Any ✗ line is a release blocker. Fix before publishing.

set -uo pipefail

INSTALL_URL="${INSTALL_URL:-https://horus.sh/install.sh}"
INSTALL_MODE=0

for arg in "$@"; do
  case "$arg" in
    --install) INSTALL_MODE=1 ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" | sed 's/^# //' | sed 's/^#//'
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

bold()  { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
yellow(){ printf '\033[33m%s\033[0m' "$*"; }

fail=0

ok()   { printf '  %s %s\n' "$(green '✓')" "$*"; }
fail_check() { printf '  %s %s\n' "$(red '✗')" "$*"; fail=1; }
warn() { printf '  %s %s\n' "$(yellow '!')" "$*"; }

# ── 1. optional curl install ───────────────────────────────────────────────────

if [ "${INSTALL_MODE}" -eq 1 ]; then
  printf '\n  %s\n\n' "$(bold 'Step 1: curl install')"
  printf '  %s\n' "Installer: ${INSTALL_URL}"

  # Safety check: abort if an existing horus binary could be overwritten.
  # The installer places the binary in /usr/local/bin or $HOME/.local/bin.
  # Overwriting a developer's live binary without consent is not acceptable.
  # To bypass (e.g. in a fresh container): set HORUS_INSTALL_UNSAFE=1.
  # Preferred isolation: docker run --rm ubuntu:22.04 bash -c \
  #   'apt-get install -y curl nodejs && curl -fsSL <URL> | bash && horus --version'
  _existing_horus=""
  for _candidate in /usr/local/bin/horus "${HOME}/.local/bin/horus"; do
    if [ -f "${_candidate}" ]; then
      _existing_horus="${_candidate}"
      break
    fi
  done
  if [ -n "${_existing_horus}" ] && [ -z "${HORUS_INSTALL_UNSAFE:-}" ]; then
    fail_check "--install safety: ${_existing_horus} already exists"
    warn "The installer may overwrite this binary. Options:"
    warn "  1. Run in a fresh container (recommended):"
    warn "     docker run --rm ubuntu:22.04 bash -c 'apt-get install -y curl nodejs && curl -fsSL ${INSTALL_URL} | bash && horus --version'"
    warn "  2. Set HORUS_INSTALL_UNSAFE=1 to proceed anyway (overwrites ${_existing_horus})"
    printf '\n  %s\n\n' "$(red "$(bold 'FAIL — isolated environment required for --install mode')")"
    exit 1
  fi

  INSTALL_OUTPUT="$(mktemp)"
  if curl -fsSL "${INSTALL_URL}" | bash 2>&1 | tee "${INSTALL_OUTPUT}"; then
    ok "curl install exited 0"
  else
    fail_check "curl install failed (non-zero exit)"
  fi

  # Installer must not identify Axon as the product being installed.
  # axoniq (the optional source-intelligence backend PyPI package) is expected and allowed.
  # Use word-boundary match so "axoniq" is not caught (\baxon\b requires a non-word char
  # or string boundary after "axon"; the "i" in "axoniq" provides no such boundary).
  if grep -qiE '\baxon\b' "${INSTALL_OUTPUT}"; then
    fail_check "installer output identifies product as 'Axon' — branding leak"
    warn "  Found: $(grep -iE '\baxon\b' "${INSTALL_OUTPUT}" | head -3)"
  else
    ok "installer output does not identify product as Axon"
  fi

  rm -f "${INSTALL_OUTPUT}"
else
  printf '\n  %s\n\n' "$(bold 'Horus release smoke test')"
  warn "Skipping curl install — using existing PATH or HORUS_BIN"
  warn "Pass --install to test the full curl-install path"
  printf '\n'
fi

# ── 2. resolve the horus binary ───────────────────────────────────────────────

if [ -n "${HORUS_BIN:-}" ]; then
  if [ ! -f "${HORUS_BIN}" ]; then
    fail_check "HORUS_BIN=${HORUS_BIN} not found"
    exit 1
  fi
  HORUS=("node" "${HORUS_BIN}")
  ok "Using HORUS_BIN: ${HORUS_BIN}"
elif command -v horus &>/dev/null; then
  HORUS=("horus")
  ok "horus is on PATH: $(command -v horus)"
else
  fail_check "horus not found on PATH and HORUS_BIN is not set"
  printf '  %s\n' "Install with: curl -fsSL ${INSTALL_URL} | bash"
  printf '\n  %s\n\n' "$(red "$(bold 'FAIL — horus not installed')")"
  exit 1
fi

printf '\n  %s\n\n' "$(bold 'Step 2: command surface verification')"

# ── helpers ───────────────────────────────────────────────────────────────────

check_exit0() {
  local desc="$1"; shift
  if "${HORUS[@]}" "$@" >/dev/null 2>&1; then
    ok "${desc}"
  else
    fail_check "${desc} (non-zero exit)"
  fi
}

check_contains() {
  local desc="$1" needle="$2"; shift 2
  local out
  out="$("${HORUS[@]}" "$@" 2>&1 || true)"
  if printf '%s' "${out}" | grep -qF -- "${needle}"; then
    ok "${desc}"
  else
    fail_check "${desc}"
    printf '    expected to contain: %s\n' "${needle}"
    printf '    got:                 %s\n' "$(printf '%s' "${out}" | head -5)"
  fi
}

check_not_contains() {
  local desc="$1" needle="$2"; shift 2
  local out
  out="$("${HORUS[@]}" "$@" 2>&1 || true)"
  if ! printf '%s' "${out}" | grep -qi -- "${needle}"; then
    ok "${desc}"
  else
    fail_check "${desc}"
    printf '    must NOT contain:    %s\n' "${needle}"
    printf '    found in output:     %s\n' "$(printf '%s' "${out}" | grep -i "${needle}" | head -3)"
  fi
}

# ── 3. --version ──────────────────────────────────────────────────────────────

check_exit0       "--version exits 0"                            --version
check_contains    "--version shows 'horus'"        "horus"       --version
check_contains    "--version shows semver"          "0."          --version
# The CLI must not identify itself as Axon in version output.
check_not_contains "--version does not show 'Axon'" "Axon"       --version

# ── 4. --help ────────────────────────────────────────────────────────────────

check_exit0       "--help exits 0"                               --help
check_contains    "--help lists investigate"  "investigate"      --help
check_contains    "--help lists setup"        "setup"            --help
check_contains    "--help lists index"        "index"            --help
check_contains    "--help lists connect"      "connect"          --help
# The usage line must name the installed CLI as "horus".
# Backend references such as "Stop the Axon host" are not product branding.
check_contains "--help usage line names product 'horus'" "Usage: horus" --help

# ── 5. sub-command help ──────────────────────────────────────────────────────

check_exit0  "setup --help exits 0"       setup       --help
check_exit0  "index --help exits 0"       index       --help
check_exit0  "investigate --help exits 0" investigate --help
check_exit0  "connect --help exits 0"     connect     --help
check_exit0  "hosts --help exits 0"       hosts       --help
check_exit0  "stop --help exits 0"        stop        --help

# ── 6. setup command (non-zero exit is acceptable when prereqs absent) ────────

# setup may exit non-zero when Node/Python versions are wrong, but it must
# still print the "Horus setup" header rather than crashing silently.
check_contains "setup prints header" "Horus setup"              setup

# ── done ─────────────────────────────────────────────────────────────────────

printf '\n'
if [ "${fail}" -eq 0 ]; then
  printf '  %s\n\n' "$(green "$(bold 'PASS — release smoke clean')")"
  exit 0
else
  printf '  %s\n\n' "$(red "$(bold 'FAIL — one or more checks failed')")"
  printf '  %s\n\n' "Fix all ✗ items above before publishing this release."
  exit 1
fi
