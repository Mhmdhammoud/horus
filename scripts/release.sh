#!/usr/bin/env bash
# Horus release script — GitHub Release artifact (no npm publishing)
#
# Distribution strategy: self-contained GitHub Release artifact
#   - apps/horus/dist/index.cjs bundled with tsup (all deps inline, Node built-ins external)
#   - Released as `horus-vX.Y.Z` executable on GitHub Releases
#   - Installer fetches from GitHub Releases — no npm step, no PyPI for the CLI itself
#
# Release order:
#   0. Preflight (gh + auth + horus-landing presence + clean trees)
#   1. Sync versions (horus + core + landing installer)
#   2. Install deps
#   3. Typecheck
#   4. Build  (path-scoped: ./apps/horus only — avoids race with root 'horus' package)
#   5. Smoke test
#   6. Commit + tag (both repos)
#   7. Push commit + tag (both repos, before GitHub Release creation)
#   8. Prepare artifact + checksum
#   9. Create GitHub Release + upload artifact
#  10. Verify artifact reachability (retries, fatal on failure)
#
# Usage:
#   ./scripts/release.sh [version]   # version defaults to apps/horus/package.json
#
# Prerequisites:
#   gh auth login  (GitHub CLI, checked before any mutations)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HORUS_REPO="Mhmdhammoud/horus"

bold()  { printf '\033[1m%s\033[0m' "$*"; }
dim()   { printf '\033[2m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
cyan()  { printf '\033[36m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
yellow(){ printf '\033[33m%s\033[0m' "$*"; }

info() { printf '  %s %s\n' "$(cyan '→')" "$*"; }
ok()   { printf '  %s %s\n' "$(green '✓')" "$*"; }
warn() { printf '  %s %s\n' "$(yellow '!')" "$*"; }
die()  { printf '\n  %s %s\n\n' "$(red '✗')" "$*" >&2; exit 1; }

sha256_file() {
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    die "sha256 tool not found (need shasum or sha256sum)"
  fi
}

APP_DIR="$ROOT/apps/horus"
APP_PKG="$APP_DIR/package.json"
VERSION_FILE="$ROOT/packages/core/src/version.ts"

# ── version ──────────────────────────────────────────────────────────────────

if [ -n "${1:-}" ]; then
  VERSION="$1"
else
  VERSION="$(node -e "const {version}=JSON.parse(require('fs').readFileSync('$APP_PKG','utf8')); process.stdout.write(version)")"
fi

TAG="v${VERSION}"

printf '\n  %s\n\n' "$(bold "⚡ Horus release: ${TAG}")"

# ── 0. preflight ──────────────────────────────────────────────────────────────
# All of these checks run before any file is modified.

info "Running preflight checks"

# gh must be installed and authenticated before any mutations.
command -v gh &>/dev/null \
  || die "gh (GitHub CLI) is not installed.
  Install from https://cli.github.com and run 'gh auth login', then re-run."
gh auth status &>/dev/null \
  || die "gh is not authenticated. Run 'gh auth login', then re-run."
ok "  gh authenticated"

# horus-landing must be present — it is the public distribution path.
LANDING_DIR=""
if [ -d "${ROOT}/../horus-landing" ]; then
  LANDING_DIR="$(cd "${ROOT}/../horus-landing" && pwd)"
fi
[ -n "${LANDING_DIR}" ] \
  || die "horus-landing repo not found at $(cd "${ROOT}/.." && pwd)/horus-landing.
  The sibling installer repository is required for a complete release.
  Clone it and re-run."
[ -f "${LANDING_DIR}/public/install.sh" ] \
  || die "horus-landing/public/install.sh not found in ${LANDING_DIR}.
  Verify the horus-landing checkout is complete."
ok "  horus-landing present"

# Both repos must be clean.
git -C "$ROOT" diff --quiet HEAD \
  || die "Uncommitted changes in horus monorepo. Commit or stash before releasing."
[ -z "$(git -C "$ROOT" ls-files --others --exclude-standard)" ] \
  || die "Untracked files present in horus monorepo. Stage or remove them before releasing."
git -C "${LANDING_DIR}" diff --quiet HEAD \
  || die "Uncommitted changes in horus-landing. Commit or stash before releasing."
ok "  Working trees clean"

# Verify remote access (fast HEAD probe — no data transferred).
git -C "$ROOT" ls-remote --exit-code origin &>/dev/null \
  || die "Cannot reach horus origin remote. Check network/credentials."
git -C "${LANDING_DIR}" ls-remote --exit-code origin &>/dev/null \
  || die "Cannot reach horus-landing origin remote. Check network/credentials."
ok "  Remote access confirmed"

ok "Preflight passed"

# ── 1. version sync ───────────────────────────────────────────────────────────

info "Setting version ${VERSION}"

node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('$APP_PKG', 'utf8'));
  p.version = '$VERSION';
  fs.writeFileSync('$APP_PKG', JSON.stringify(p, null, 2) + '\n');
"
ok "  apps/horus/package.json → ${VERSION}"

sed -i.bak "s/HORUS_VERSION = '[^']*'/HORUS_VERSION = '${VERSION}'/" "$VERSION_FILE"
rm -f "${VERSION_FILE}.bak"
ok "  packages/core/src/version.ts → ${VERSION}"

INSTALL_SH="${LANDING_DIR}/public/install.sh"
sed -i.bak "s/^HORUS_VERSION=\"[^\"]*\"/HORUS_VERSION=\"${VERSION}\"/" "${INSTALL_SH}"
rm -f "${INSTALL_SH}.bak"
ok "  horus-landing/public/install.sh → ${VERSION}"

# ── 2. install ────────────────────────────────────────────────────────────────

info "Installing dependencies"
pnpm install --frozen-lockfile

# ── 3. typecheck ──────────────────────────────────────────────────────────────

info "Type-checking (all workspace packages)"
# Run the repo-wide typecheck so all 8 packages are validated before the build.
# The build step is path-scoped (./apps/horus) to avoid the race between the
# root 'horus' package and apps/horus sharing the same name, but release
# validation must cover the full workspace.
pnpm typecheck

# ── 4. build ──────────────────────────────────────────────────────────────────

info "Building self-contained binary: apps/horus/dist/index.cjs"
# Path filter is required: both the workspace root and apps/horus are named 'horus'.
# A name filter ('--filter horus') selects both, causing two tsup processes to race
# on the same dist directory and produce an inconsistent or corrupted artifact.
pnpm --filter ./apps/horus build

DIST_FILE="$APP_DIR/dist/index.cjs"
[ -f "$DIST_FILE" ] || die "Build output not found: $DIST_FILE"
ok "Built: $DIST_FILE ($(du -sh "$DIST_FILE" | cut -f1))"

# ── 5. smoke test ─────────────────────────────────────────────────────────────

info "Running smoke test"
"$ROOT/scripts/smoke-test.sh" apps/horus/dist/index.cjs
ok "Smoke test passed"

# ── 6. commit + tag ───────────────────────────────────────────────────────────

info "Committing and tagging ${TAG}"

git -C "$ROOT" add apps/horus/package.json packages/core/src/version.ts
git -C "$ROOT" commit -m "chore: release ${TAG}"
git -C "$ROOT" tag -a "$TAG" -m "Horus ${TAG}"
ok "  horus: committed and tagged ${TAG}"

git -C "${LANDING_DIR}" add public/install.sh
git -C "${LANDING_DIR}" commit -m "chore: point installer at horus ${TAG}"
LANDING_BRANCH="$(git -C "${LANDING_DIR}" rev-parse --abbrev-ref HEAD)"
ok "  horus-landing: committed install.sh update"

# ── 7. push (must precede GitHub Release creation) ────────────────────────────

info "Pushing to origin (required before GitHub Release creation)"
git -C "$ROOT" push origin master \
  || die "Failed to push horus master — Release creation aborted."
git -C "$ROOT" push origin "$TAG" \
  || die "Failed to push tag ${TAG} — Release creation aborted."
ok "  Pushed horus master + ${TAG}"

git -C "${LANDING_DIR}" push origin "${LANDING_BRANCH}" \
  || die "Failed to push horus-landing/${LANDING_BRANCH} — Release creation aborted.
  The public installer must be updated before the release artifact is published."
ok "  Pushed horus-landing/${LANDING_BRANCH}"

# ── 8. prepare release artifact ───────────────────────────────────────────────

ARTIFACT_NAME="horus-${TAG}"
ARTIFACT_FILE="$APP_DIR/dist/${ARTIFACT_NAME}"
CHECKSUM_FILE="${ARTIFACT_FILE}.sha256"

cp "$DIST_FILE" "$ARTIFACT_FILE"
chmod +x "$ARTIFACT_FILE"
sha256_file "$ARTIFACT_FILE" > "$CHECKSUM_FILE"

ok "Artifact: ${ARTIFACT_FILE} ($(du -sh "$ARTIFACT_FILE" | cut -f1))"
ok "Checksum: $(cat "$CHECKSUM_FILE")"

# ── 9. create github release ──────────────────────────────────────────────────

info "Creating GitHub Release ${TAG}"
gh release create "$TAG" \
  --title "Horus ${TAG}" \
  --notes "## Install

\`\`\`bash
curl -fsSL https://horus.sh/install.sh | bash
\`\`\`

## Requirements

- Node.js 22+ (the CLI is a self-contained Node.js executable)
- Python 3.11+ with uv or pip (optional — enables source-intelligence features)

## Verify

\`\`\`bash
horus --version   # → horus ${VERSION}
horus --help
horus setup
\`\`\`

## Direct download (Linux/macOS)

\`\`\`bash
curl -fsSL https://github.com/${HORUS_REPO}/releases/download/${TAG}/horus-${TAG} -o horus
chmod +x horus
sudo mv horus /usr/local/bin/horus
horus --version
\`\`\`

## Checksum (sha256)

\`\`\`
$(cat "$CHECKSUM_FILE")  horus-${TAG}
\`\`\`" \
  "$ARTIFACT_FILE" \
  "$CHECKSUM_FILE" \
  || die "gh release create failed — the tag is pushed but the Release was not created.
  Run 'gh release create ${TAG} ...' manually with the artifacts in $APP_DIR/dist/"

ok "GitHub Release: https://github.com/${HORUS_REPO}/releases/tag/${TAG}"

# ── 10. verify artifact reachability (bounded retries, fatal) ─────────────────

info "Verifying release artifact is reachable"
RELEASE_URL="https://github.com/${HORUS_REPO}/releases/download/${TAG}/${ARTIFACT_NAME}"
VERIFIED=0
for attempt in 1 2 3; do
  HTTP_STATUS="$(curl -sIL -o /dev/null -w '%{http_code}' "${RELEASE_URL}" 2>/dev/null || true)"
  if [ "${HTTP_STATUS}" = "200" ]; then
    ok "Artifact reachable (attempt ${attempt}): ${RELEASE_URL}"
    VERIFIED=1
    break
  fi
  if [ "${attempt}" -lt 3 ]; then
    warn "Attempt ${attempt}: HTTP ${HTTP_STATUS} — waiting 10s before retry"
    sleep 10
  fi
done

[ "${VERIFIED}" -eq 1 ] \
  || die "Artifact not reachable after 3 attempts (HTTP ${HTTP_STATUS}).
  The release was created — verify manually:
    ${RELEASE_URL}"

# ── done ──────────────────────────────────────────────────────────────────────

printf '\n  %s\n\n' "$(green "$(bold "✓ Horus ${TAG} released")")"
printf '  %s\n' "GitHub: https://github.com/${HORUS_REPO}/releases/tag/${TAG}"
printf '  %s\n' "Install: curl -fsSL https://horus.sh/install.sh | bash"
printf '\n'
