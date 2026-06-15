#!/usr/bin/env bash
# Branding regression check (HOR-119)
#
# Checks user-visible CLI output strings and Commander help text for disallowed
# "Axon" branding. Run this before any release to catch accidental regressions.
#
# Exit 0 = clean
# Exit 1 = violations found (list printed to stdout)
#
# Allowlist (intentional references — never flag these):
#   - "axon host <...>"      the external CLI binary command users must run
#   - "axon analyze <...>"   the external CLI binary command for repo indexing
#   - "axon serve"           the external CLI binary command for MCP mode
#   - "'axon' not found"     binary availability check error message
#   - "`axon` not found"     same, backtick variant
#   - ".axon/"               on-disk directory created by the axon binary
#   - "--axon"               the --axon <url> CLI flag (config key cannot be renamed yet)
#   - "axoniq"               PyPI package name (upstream; Horus cannot rename it)
#   - "axon --version"       binary version probe

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Surfaces to check: user-visible output strings and Commander API calls.
# We target specific patterns rather than whole files to avoid flagging
# code comments, type names, and test describe blocks.
CLI_COMMANDS="$REPO_ROOT/packages/cli/src/commands"
CLI_INDEX="$REPO_ROOT/packages/cli/src/index.ts"

# Patterns that constitute user-visible output or help text in TypeScript source.
USER_VISIBLE_PATTERN='(console\.(log|error|warn)|pc\.|\.description\(|\.option\(|\.addHelpText\(|\.argument\()'

violations=0
violation_lines=()

# Search user-visible lines for capital-A Axon used as a brand noun.
# We look for "Axon" followed by a space or word boundary that indicates it is
# being used as a product label (e.g. "Axon host unreachable", "an Axon host").
while IFS= read -r match; do
  file="${match%%:*}"
  rest="${match#*:}"
  linenum="${rest%%:*}"
  text="${rest#*:}"

  # Skip lines where Axon appears only as an allowlisted reference.
  # (These checks use grep -qE on the text to match known-safe patterns.)

  # CLI binary invocations: "axon host", "axon analyze", "axon serve", "axon --version"
  if echo "$text" | grep -qiE '(axon host|axon analyze|axon serve|axon --version)'; then
    continue
  fi

  # Binary availability check: "'axon' not found" or "`axon` not found"
  if echo "$text" | grep -qiE "(['\`]axon['\`]) (not found|is)"; then
    continue
  fi

  # CLI flag reference: --axon
  if echo "$text" | grep -qiE '(--axon|pass --axon)'; then
    continue
  fi

  # On-disk directory or file created by the axon binary (.axon/ .axon present, etc.)
  if echo "$text" | grep -qiE '\.axon\b'; then
    continue
  fi

  # Config property access: repo.axon.hostUrl — the value is a URL, not "Axon" branding
  if echo "$text" | grep -qiE '\baxon\.(hostUrl|version|port)\b|\brepo\.axon\b'; then
    continue
  fi

  # PyPI package name
  if echo "$text" | grep -qiE 'axoniq'; then
    continue
  fi

  violations=$((violations + 1))
  violation_lines+=("  $file:$linenum: $text")
done < <(
  grep -rn --include="*.ts" -E "$USER_VISIBLE_PATTERN" "$CLI_COMMANDS" "$CLI_INDEX" 2>/dev/null \
  | grep -iE '\bAxon\b'
)

if [[ $violations -eq 0 ]]; then
  echo "✓ No disallowed Axon branding in user-visible CLI surfaces"
  exit 0
fi

echo "✗ Disallowed Axon branding found ($violations occurrence(s)):"
echo ""
for v in "${violation_lines[@]}"; do
  echo "$v"
done
echo ""
echo "Allowed Axon references (update allowlist in scripts/check-branding.sh if intentional):"
echo "  axon host / axon analyze / axon serve  — CLI binary commands"
echo "  'axon' / \`axon\` not found              — binary name in error messages"
echo "  --axon <url>                            — config flag (cannot rename yet)"
echo "  .axon/ directory                        — on-disk artifact of the axon binary"
echo "  axoniq                                  — PyPI package name (upstream)"
exit 1
