#!/usr/bin/env bash
# Build per-platform Homebrew archives and SHA-256 checksums for Horus.
#
# Usage:
#   ./scripts/homebrew/build-archives.sh [version] [source-executable]
#
# Defaults:
#   version          -> apps/horus/package.json version
#   source-executable -> apps/horus/dist/index.cjs
#
# Output:
#   .homebrew-archives/horus-v<VERSION>-<OS>-<ARCH>.tar.gz
#   .homebrew-archives/horus-v<VERSION>-<OS>-<ARCH>.tar.gz.sha256

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_PKG="$ROOT/apps/horus/package.json"

VERSION="${1:-$(node -e "const {version}=JSON.parse(require('fs').readFileSync('$APP_PKG','utf8')); process.stdout.write(version)")}"
SOURCE="${2:-$ROOT/apps/horus/dist/index.cjs}"
OUTDIR="$ROOT/.homebrew-archives"

if [ ! -f "$SOURCE" ]; then
  echo "Source executable not found: $SOURCE" >&2
  exit 1
fi

mkdir -p "$OUTDIR"

sha256_file() {
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "sha256 tool not found" >&2
    exit 1
  fi
}

for platform in darwin-arm64 darwin-x86_64 linux-arm64 linux-x86_64; do
  IFS='-' read -r OS ARCH <<< "$platform"
  ARTIFACT="horus-v${VERSION}-${platform}.tar.gz"
  ARTIFACT_PATH="$OUTDIR/$ARTIFACT"
  TMP=$(mktemp -d)

  mkdir -p "$TMP/horus/bin"
  cp "$SOURCE" "$TMP/horus/bin/horus"
  chmod +x "$TMP/horus/bin/horus"

  tar -czf "$ARTIFACT_PATH" -C "$TMP" horus
  rm -rf "$TMP"

  CHECKSUM=$(sha256_file "$ARTIFACT_PATH")
  echo "${CHECKSUM}  ${ARTIFACT}" > "$ARTIFACT_PATH.sha256"

  echo "Built: $ARTIFACT_PATH"
  echo "Checksum: ${CHECKSUM}"
done
