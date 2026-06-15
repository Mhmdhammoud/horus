# Meritt Dev Homebrew Tap

This directory contains the Homebrew tap for Horus.

It is intended to be pushed to the `meritt-dev/homebrew-tap` repository so users can run:

```bash
brew tap meritt-dev/tap
brew install horus
```

or directly:

```bash
brew install meritt-dev/tap/horus
```

## Layout

```
Formula/
  horus.rb          # Formula for the Horus CLI
```

## What the formula installs

- The `horus` command from the platform archive defined in [`docs/homebrew-archive-contract.md`](https://github.com/meritt-dev/horus/blob/master/docs/homebrew-archive-contract.md).
- Node.js is declared as a dependency because the Horus binary is a self-contained Node.js executable.

## Publishing

Do not push this directory to `meritt-dev/homebrew-tap` until the release archives referenced by `Formula/horus.rb` have been uploaded to the Horus GitHub Release. See the implementation notes on HOR-124 for status.

## CI

The `.github/workflows/tests.yml` workflow runs on push/PR once this directory is the root of `meritt-dev/homebrew-tap`:

- **Audit job** — runs `brew audit --strict meritt-dev/tap/horus` to catch formula style and structure issues.
- **Test job** — downloads the published Horus executable, builds the per-platform archive set locally, and installs/tests the formula from a temporary tap using `file://` URLs so it does not depend on the release archives already being uploaded.

## Local validation

From the Horus repo:

```bash
# Audit the formula style/structure
brew tap meritt-dev/tap "$(pwd)/homebrew-tap"
brew audit --strict meritt-dev/tap/horus
```

To install and test locally before the archives are on GitHub, build local archives and use a temporary tap with `file://` URLs:

```bash
VERSION=0.1.0
# Download the published Horus executable (or use apps/horus/dist/index.cjs)
curl -fsSL "https://github.com/meritt-dev/horus/releases/download/v${VERSION}/horus-v${VERSION}" -o /tmp/horus-exec
chmod +x /tmp/horus-exec

# Build the archive set
./scripts/homebrew/build-archives.sh "$VERSION" /tmp/horus-exec

# Create a temporary tap that points at the local archives
mkdir -p /tmp/horus-test-tap/Formula
sed "s|https://github.com/meritt-dev/horus/releases/download/v${VERSION}/|file://$(pwd)/.homebrew-archives/|g" \
  homebrew-tap/Formula/horus.rb > /tmp/horus-test-tap/Formula/horus.rb
cd /tmp/horus-test-tap && git init -q && git add . && git commit -q -m "local test"

# Install and test
brew tap horus-local/test /tmp/horus-test-tap
brew install --build-from-source horus-local/test/horus
brew test horus-local/test/horus
```
