#!/usr/bin/env bash
# HOR-152 — Local release smoke test
#
# Exercises the full Horus command surface against a real local project repo.
# Run this after every release to catch regressions before they reach users.
#
# Usage:
#   scripts/release/local-smoke.sh <repo-path>
#   scripts/release/local-smoke.sh --help
#
# Options:
#   --skip-install    Skip install channel checks (--version / npm / curl)
#   --skip-curl       Skip only the curl installer test (keeps --version + npm checks)
#   --keep-config     Do not wipe .horus before the onboarding smoke
#
# Output:
#   Per-command ✓/✗ lines, a section PASS/FAIL summary, and a timestamped log
#   at tmp/horus-smoke-YYYYMMDD-HHMMSS.log relative to the horus repo root.
#
# Exit code:
#   0  all sections pass
#   1  at least one release-blocking section fails
#
# Required connectors for full coverage:
#   - Postgres (investigate/replay/postmortem/scoring)
#   - Source-intelligence backend (index/explain/architecture/blast-radius/owner/search/queues)
#   Commands that need unavailable connectors are marked ⚠ and do not fail the section.

set -uo pipefail

# ── repo roots ────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HORUS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── argument parsing ──────────────────────────────────────────────────────────

REPO_PATH=""
SKIP_INSTALL=0
SKIP_CURL=0
KEEP_CONFIG=0

for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-curl)    SKIP_CURL=1    ;;
    --keep-config)  KEEP_CONFIG=1  ;;
    --help|-h)
      sed -n '2,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 1
      ;;
    *)
      if [ -z "${REPO_PATH}" ]; then
        REPO_PATH="$arg"
      else
        printf 'Unexpected argument: %s\n' "$arg" >&2
        exit 1
      fi
      ;;
  esac
done

if [ -z "${REPO_PATH}" ]; then
  printf 'Usage: %s <repo-path> [--skip-install] [--skip-curl] [--keep-config]\n' \
    "$(basename "$0")" >&2
  exit 1
fi

if [ ! -d "${REPO_PATH}" ]; then
  printf 'Repo path does not exist: %s\n' "${REPO_PATH}" >&2
  exit 1
fi

REPO_PATH="$(cd "${REPO_PATH}" && pwd)"
REPO_NAME="$(basename "${REPO_PATH}")"

# ── log file ──────────────────────────────────────────────────────────────────

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
LOG_DIR="${HORUS_ROOT}/tmp"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/horus-smoke-${TIMESTAMP}.log"

# Tee all output to log file. Use a subshell so the trap still fires in the
# outer process; the inner script runs fully, then the tee receives EOF.
exec > >(tee -a "${LOG_FILE}") 2>&1

# ── colour helpers ─────────────────────────────────────────────────────────────

bold()   { printf '\033[1m%s\033[0m' "$*"; }
dim()    { printf '\033[2m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
red()    { printf '\033[31m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }
cyan()   { printf '\033[36m%s\033[0m' "$*"; }

# ── state ─────────────────────────────────────────────────────────────────────

# Section results: 0 = pass, 1 = fail
SEC_INSTALL=0
SEC_ONBOARD=0
SEC_INVEST=0
SEC_SOURCE=0
SEC_CHANGE=0
SEC_STATUS=0
SEC_SCORE=0

INVESTIGATION_ID=""

# ── horus binary ──────────────────────────────────────────────────────────────

if ! command -v horus &>/dev/null; then
  printf '\n  %s horus not found on PATH\n\n' "$(red '✗')" >&2
  exit 1
fi
HORUS=("horus")

# ── check helpers ─────────────────────────────────────────────────────────────

# ok/fail/warn: print a result line. fail() marks the current section.
_SEC_FAIL_VAR=""  # set by section() to track which variable to mark on failure

section() {
  _SEC_FAIL_VAR="$1"
  printf '\n  %s\n' "$(bold "$(cyan '▶') $2")"
}

ok()   { printf '    %s %s\n' "$(green '✓')" "$*"; }
fail() { printf '    %s %s\n' "$(red '✗')" "$*"; eval "${_SEC_FAIL_VAR}=1"; }
warn() { printf '    %s %s\n' "$(yellow '⚠')" "$*"; }
note() { printf '    %s %s\n' "$(dim  '·')" "$*"; }

# run_check: run a command, print ok/fail based on exit code.
# Usage: run_check "description" cmd args...
run_check() {
  local desc="$1"; shift
  local out exit_code=0
  out="$("${HORUS[@]}" "$@" 2>&1)" || exit_code=$?
  if [ "${exit_code}" -eq 0 ]; then
    ok "${desc}"
    printf '%s\n' "${out}" | sed 's/^/      /'
    return 0
  else
    fail "${desc} (exit ${exit_code})"
    printf '%s\n' "${out}" | head -5 | sed 's/^/      /'
    return 1
  fi
}

# check_output: run a command, require a string in combined output.
# Usage: check_output "description" "needle" cmd args...
check_output() {
  local desc="$1" needle="$2"; shift 2
  local out
  out="$("${HORUS[@]}" "$@" 2>&1 || true)"
  if printf '%s' "${out}" | grep -qF -- "${needle}"; then
    ok "${desc}"
    return 0
  else
    fail "${desc} — expected: ${needle}"
    printf '%s\n' "${out}" | head -5 | sed 's/^/      /'
    return 1
  fi
}

# check_warn: run a command that may exit non-zero; warn (not fail) if it does.
# Use for connector-dependent commands where missing connectors are expected.
check_warn() {
  local desc="$1"; shift
  local out exit_code=0
  out="$("${HORUS[@]}" "$@" 2>&1)" || exit_code=$?
  if [ "${exit_code}" -eq 0 ]; then
    ok "${desc}"
  else
    warn "${desc} (exit ${exit_code} — connector may be absent)"
    printf '%s\n' "${out}" | head -3 | sed 's/^/      /'
  fi
}

# in_repo: run a command inside the target repo directory.
in_repo() { (cd "${REPO_PATH}" && "${HORUS[@]}" "$@"); }
in_repo_raw() { (cd "${REPO_PATH}" && "$@"); }

# ── banner ────────────────────────────────────────────────────────────────────

printf '\n  %s\n' "$(bold "⚡ Horus local release smoke")"
printf '  %s %s\n' "$(dim 'Repo:')"      "$(dim "${REPO_PATH}")"
printf '  %s %s\n' "$(dim 'Log:')"       "$(dim "${LOG_FILE}")"
printf '  %s %s\n' "$(dim 'Timestamp:')" "$(dim "${TIMESTAMP}")"

# ── § 1  INSTALL ──────────────────────────────────────────────────────────────

section SEC_INSTALL "Install channel verification"

if [ "${SKIP_INSTALL}" -eq 1 ]; then
  note "Skipped (--skip-install)"
else
  # 1a. PATH binary
  HORUS_VERSION_OUT="$(horus --version 2>&1 || true)"
  if printf '%s' "${HORUS_VERSION_OUT}" | grep -qE '^horus [0-9]+\.[0-9]+\.[0-9]+'; then
    ok "--version: ${HORUS_VERSION_OUT}"
  else
    fail "--version did not return expected semver output"
    printf '      got: %s\n' "${HORUS_VERSION_OUT}"
  fi

  # 1b. npm registry version
  if command -v npm &>/dev/null; then
    NPM_VERSION="$(npm view @merittdev/horus version 2>/dev/null || true)"
    if [ -n "${NPM_VERSION}" ]; then
      ok "npm registry: @merittdev/horus@${NPM_VERSION}"
    else
      warn "npm view @merittdev/horus returned empty (registry may be slow)"
    fi
  else
    note "npm not found — skipping npm registry check"
  fi

  # 1c. curl installer — isolated to a temp dir so the dev's binary is not overwritten
  if [ "${SKIP_CURL}" -eq 1 ]; then
    note "Skipping curl install (--skip-curl)"
  elif ! command -v curl &>/dev/null; then
    note "curl not found — skipping curl installer check"
  else
    CURL_TMPDIR="$(mktemp -d)"
    CURL_LOG="${CURL_TMPDIR}/install.log"
    ORIG_PATH="${PATH}"
    # Prepend a private bin dir so the installer writes there, not to /usr/local/bin.
    # The script checks if its target dir is writable; by exporting a writable dir
    # first on PATH we steer it without needing sudo and without touching the live binary.
    mkdir -p "${CURL_TMPDIR}/bin"
    INSTALL_OUTPUT="$(PATH="${CURL_TMPDIR}/bin:${PATH}" HORUS_INSTALL_DIR="${CURL_TMPDIR}/bin" \
      curl -fsSL https://horus.sh/install.sh 2>/dev/null | \
      PATH="${CURL_TMPDIR}/bin:${ORIG_PATH}" bash 2>&1 || true)"
    CURL_EXIT=$?
    export PATH="${ORIG_PATH}"
    if [ "${CURL_EXIT}" -eq 0 ]; then
      ok "curl install exited 0"
      # Verify the installed binary is runnable
      if [ -f "${CURL_TMPDIR}/bin/horus" ]; then
        CURL_VER="$("${CURL_TMPDIR}/bin/horus" --version 2>&1 || true)"
        if printf '%s' "${CURL_VER}" | grep -qE 'horus [0-9]'; then
          ok "curl-installed binary --version: ${CURL_VER}"
        else
          fail "curl-installed binary --version returned unexpected output"
          printf '      got: %s\n' "${CURL_VER}"
        fi
      else
        note "curl-installed binary not found at expected path (installer may use different dir)"
      fi
    else
      fail "curl install exited ${CURL_EXIT}"
      printf '%s\n' "${INSTALL_OUTPUT}" | tail -10 | sed 's/^/      /'
    fi
    rm -rf "${CURL_TMPDIR}"
  fi
fi

# ── § 2  ONBOARDING ───────────────────────────────────────────────────────────

section SEC_ONBOARD "Onboarding smoke (init → index → doctor → investigate → explain)"

# 2a. Clean state (unless --keep-config)
if [ "${KEEP_CONFIG}" -eq 0 ]; then
  if [ -d "${REPO_PATH}/.horus" ]; then
    note "Removing ${REPO_PATH}/.horus (use --keep-config to skip)"
    rm -rf "${REPO_PATH}/.horus"
  fi
fi

# 2b. horus init
INIT_OUT="$(in_repo init 2>&1 || true)"
if printf '%s' "${INIT_OUT}" | grep -qF 'Initialized Horus project'; then
  ok "horus init — project created"
elif printf '%s' "${INIT_OUT}" | grep -qF '.horus/config.json'; then
  ok "horus init — config created"
else
  fail "horus init — unexpected output"
  printf '%s\n' "${INIT_OUT}" | head -5 | sed 's/^/      /'
fi

# 2c. horus doctor (pre-index — source host should not be configured yet)
DOCTOR_PRE="$(in_repo doctor 2>&1 || true)"
if printf '%s' "${DOCTOR_PRE}" | grep -qF 'Horus readiness check'; then
  ok "horus doctor (pre-index) — readiness header present"
else
  fail "horus doctor (pre-index) — missing 'Horus readiness check' header"
fi
if printf '%s' "${DOCTOR_PRE}" | grep -qF 'CLI version'; then
  ok "horus doctor (pre-index) — CLI version line present"
else
  fail "horus doctor (pre-index) — missing CLI version line"
fi

# 2d. horus index — starts source intelligence host and persists it to config
note "Running horus index (may take a while on first run)…"
INDEX_OUT="$(in_repo index 2>&1)" && INDEX_EXIT=0 || INDEX_EXIT=$?
if [ "${INDEX_EXIT}" -eq 0 ]; then
  ok "horus index — exited 0"
  if printf '%s' "${INDEX_OUT}" | grep -qiE 'Indexed|source-intelligence|source host'; then
    ok "horus index — source host registered"
  else
    warn "horus index — source host registration line not found in output"
    printf '%s\n' "${INDEX_OUT}" | tail -5 | sed 's/^/      /'
  fi
else
  warn "horus index — exited ${INDEX_EXIT} (source-intelligence backend may be absent)"
  printf '%s\n' "${INDEX_OUT}" | tail -5 | sed 's/^/      /'
fi

# 2e. horus doctor (post-index) — source host should now be configured
DOCTOR_POST="$(in_repo doctor 2>&1 || true)"
if printf '%s' "${DOCTOR_POST}" | grep -qiE 'source.*host.*http|source-intelligence.*http'; then
  ok "horus doctor (post-index) — source host configured  [HOR-150 regression guard]"
else
  # Not a hard fail if index itself failed, but mark it if index succeeded
  if [ "${INDEX_EXIT}" -eq 0 ]; then
    fail "horus doctor (post-index) — source host not configured after successful index  [HOR-150]"
    printf '%s\n' "${DOCTOR_POST}" | grep -i source | head -3 | sed 's/^/      /'
  else
    warn "horus doctor (post-index) — source host not configured (index did not succeed)"
  fi
fi

# 2f. horus investigate
note "Running horus investigate (requires Postgres + source backend)…"
INVEST_HINT="getSaleWithLink slow"
INVEST_OUT="$(in_repo investigate "${INVEST_HINT}" 2>&1)" && INVEST_EXIT=0 || INVEST_EXIT=$?
if [ "${INVEST_EXIT}" -eq 0 ]; then
  ok "horus investigate — exited 0"
  # Extract investigation ID from output (format: inv_<hex> or similar)
  INVESTIGATION_ID="$(printf '%s' "${INVEST_OUT}" | grep -oE 'inv_[a-z0-9]+' | head -1 || true)"
  if [ -z "${INVESTIGATION_ID}" ]; then
    # Try alternate format: a UUID-like pattern after "id:" or "Investigation:"
    INVESTIGATION_ID="$(printf '%s' "${INVEST_OUT}" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1 || true)"
  fi
  if [ -n "${INVESTIGATION_ID}" ]; then
    ok "horus investigate — ID extracted: ${INVESTIGATION_ID}"
  else
    note "horus investigate — could not extract investigation ID from output (subsequent sections may skip)"
  fi
else
  warn "horus investigate — exited ${INVEST_EXIT} (Postgres or source backend may be absent)"
  printf '%s\n' "${INVEST_OUT}" | tail -5 | sed 's/^/      /'
fi

# 2g. horus explain
EXPLAIN_OUT="$(in_repo explain "getSaleWithLink" 2>&1)" && EXPLAIN_EXIT=0 || EXPLAIN_EXIT=$?
if [ "${EXPLAIN_EXIT}" -eq 0 ]; then
  ok "horus explain — exited 0"
else
  warn "horus explain — exited ${EXPLAIN_EXIT} (source backend may be absent)"
  printf '%s\n' "${EXPLAIN_OUT}" | tail -3 | sed 's/^/      /'
fi

# ── § 3  INVESTIGATION ────────────────────────────────────────────────────────

section SEC_INVEST "Investigation chain (investigations → replay → postmortem)"

if [ -z "${INVESTIGATION_ID}" ]; then
  warn "No investigation ID available — skipping replay/postmortem (investigate did not succeed)"
  note "Fix horus investigate, then re-run without --keep-config"
else
  check_warn "horus investigations" investigations
  check_warn "horus replay <id>" replay "${INVESTIGATION_ID}"
  check_warn "horus replay <id> --format markdown" replay "${INVESTIGATION_ID}" --format markdown
  check_warn "horus postmortem <id>" postmortem "${INVESTIGATION_ID}"
fi

# ── § 4  SOURCE INTELLIGENCE ──────────────────────────────────────────────────

section SEC_SOURCE "Source intelligence (architecture · blast-radius · owner · search · queues)"

(cd "${REPO_PATH}" && check_warn "horus architecture" architecture)
(cd "${REPO_PATH}" && check_warn "horus blast-radius <symbol>" blast-radius "getSaleWithLink")
(cd "${REPO_PATH}" && check_warn "horus owner <symbol>" owner "getSaleWithLink")
(cd "${REPO_PATH}" && check_warn "horus search <query>" search "sale collection link")
(cd "${REPO_PATH}" && check_warn "horus queues" queues)

# ── § 5  CHANGE INTELLIGENCE ──────────────────────────────────────────────────

section SEC_CHANGE "Change intelligence (changes · timeline · what-changed)"

# changes requires git history; expected to work from the repo root
(cd "${REPO_PATH}" && check_warn "horus changes HEAD~5 HEAD" changes HEAD~5 HEAD)
(cd "${REPO_PATH}" && check_warn "horus timeline" timeline)
(cd "${REPO_PATH}" && check_warn "horus what-changed" what-changed)

# ── § 6  STATUS / REGISTRY ────────────────────────────────────────────────────

section SEC_STATUS "Status / registry (status · repos · hosts)"

# These should exit 0 even with no connectors configured
(cd "${REPO_PATH}" && run_check "horus status" status) || true
check_warn "horus repos"  repos
check_warn "horus hosts"  hosts

# ── § 7  SCORING ─────────────────────────────────────────────────────────────

section SEC_SCORE "Scoring (score · ask · scores)"

if [ -z "${INVESTIGATION_ID}" ]; then
  warn "No investigation ID — skipping scoring commands"
else
  (cd "${REPO_PATH}" && check_warn "horus score <id>" score "${INVESTIGATION_ID}")
  (cd "${REPO_PATH}" && check_warn "horus ask <id> <question>" ask "${INVESTIGATION_ID}" "focus on api behavior")
  (cd "${REPO_PATH}" && check_warn "horus scores" scores)
fi

# ── summary ───────────────────────────────────────────────────────────────────

_pass() { [ "$1" -eq 0 ] && printf '%s' "$(green 'PASS')" || printf '%s' "$(red 'FAIL')"; }
_overall=0
[ "${SEC_INSTALL}" -eq 0 ] || _overall=1
[ "${SEC_ONBOARD}" -eq 0 ] || _overall=1
[ "${SEC_INVEST}"  -eq 0 ] || _overall=1
[ "${SEC_SOURCE}"  -eq 0 ] || _overall=1
[ "${SEC_CHANGE}"  -eq 0 ] || _overall=1
[ "${SEC_STATUS}"  -eq 0 ] || _overall=1
[ "${SEC_SCORE}"   -eq 0 ] || _overall=1

printf '\n'
printf '  %s\n' "$(bold 'Summary')"
printf '  %-24s %s\n' "Install:"            "$(_pass "${SEC_INSTALL}")"
printf '  %-24s %s\n' "Onboarding:"         "$(_pass "${SEC_ONBOARD}")"
printf '  %-24s %s\n' "Investigation:"      "$(_pass "${SEC_INVEST}")"
printf '  %-24s %s\n' "Source intelligence:" "$(_pass "${SEC_SOURCE}")"
printf '  %-24s %s\n' "Change intelligence:" "$(_pass "${SEC_CHANGE}")"
printf '  %-24s %s\n' "Status / registry:"  "$(_pass "${SEC_STATUS}")"
printf '  %-24s %s\n' "Scoring:"            "$(_pass "${SEC_SCORE}")"
printf '  %s\n' "$(dim '────────────────────────────────')"
printf '  %-24s %s\n' "Overall:"            "$(_pass "${_overall}")"
printf '\n'
printf '  %s %s\n' "$(dim 'Log:')" "$(dim "${LOG_FILE}")"
printf '\n'

exit "${_overall}"
