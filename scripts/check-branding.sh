#!/usr/bin/env bash
# Branding regression check (HOR-119, extended HOR-144, finalized HOR-139)
#
# The legacy upstream name (the one this guard searches for) has been fully
# removed; the canonical name is "source" / "Source" / "SOURCE". This guard
# fails if ANY case-insensitive trace of the old name reappears anywhere in the
# tracked source tree. Run it before a release to catch accidental regressions.
#
# Exit 0 = clean (no legacy-name trace anywhere)
# Exit 1 = violations found (list printed to stdout)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Build the legacy term from fragments so the literal string never appears in
# this file (otherwise this guard would flag itself).
LEGACY_TERM="a$(printf 'x')on"

# Search the whole repo, excluding build artifacts and vendored deps.
if matches="$(rg -i --line-number "${LEGACY_TERM}" \
  -g '!node_modules' -g '!dist' -g '!build' -g '!*.lock' . 2>/dev/null)"; then
  echo "✗ Disallowed legacy branding found — the name is 'source', not the old upstream:"
  echo ""
  echo "$matches"
  exit 1
fi

echo "✓ No legacy branding traces remain"
exit 0
