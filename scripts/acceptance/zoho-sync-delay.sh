#!/usr/bin/env bash
#
# HOR-17 — first product-level acceptance test for Horus.
# Replays the "Zoho sync delays" incident against the live Axon host (:8420) + Postgres
# (:5433) and asserts the investigation surfaces the expected structure. Exits non-zero
# if any expectation regresses.
#
# Prereqs: `axon host --port 8420` inside leadcall-api, `docker compose up -d`, `pnpm build`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="node $ROOT/apps/horus/dist/index.js"
HINT="zoho sync delays"

fail=0
check() { # check "<description>" "<expected substring>" "<haystack>"
  if printf '%s' "$3" | grep -qiF -- "$2"; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1 — expected to find: $2"
    fail=1
  fi
}

echo "== HOR-17 acceptance: \"$HINT\" =="

# Build the queue map, then run the investigation.
$BIN index >/dev/null 2>&1
REPORT="$($BIN investigate "$HINT" 2>&1)"
if [ -z "$REPORT" ]; then
  echo "  ✗ investigate produced no output (is the Axon host on :8420 and Postgres up?)"
  exit 1
fi

# The async boundary Axon can't stitch — the heart of the scenario.
check "resolves the Zoho sync source"        "ZohoService"            "$REPORT"
check "surfaces the realtime queue boundary"  "zoho-sync-realtime"     "$REPORT"
check "surfaces the batch queue boundary"     "zoho-sync-batch"        "$REPORT"
check "names the consuming worker"            "ZohoRealtimeProcessor"  "$REPORT"
# Disciplined reasoning: competing, ranked, validated hypotheses.
check "generates the queue-backlog hypothesis" "queue-backlog"        "$REPORT"
check "marks a hypothesis supported"          "supported"             "$REPORT"
# Honesty about uncertainty.
check "surfaces evidence gaps"                "Evidence gaps"          "$REPORT"
check "caps confidence (ceiling)"             "Confidence ceiling"     "$REPORT"
# Actionable output.
check "offers next actions"                   "Next actions"          "$REPORT"

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — Horus reconstructed the async Zoho sync path and reasoned about it."
  exit 0
else
  echo "FAIL — one or more acceptance expectations regressed."
  exit 1
fi
