# Horus Homebrew packaging archive contract

**Owner:** HOR-DX — Distribution & Developer Experience  
**Ticket:** HOR-123  
**Status:** Contract defined. Formula and archive generation are deferred to HOR-124.

This document defines the archive contract that the future Horus Homebrew tap/formula will consume. It does **not** create the formula, publish anything, or change runtime investigation behavior.

## 1. Supported Homebrew target platforms

Homebrew archives are built for the same platforms the curl installer already supports:

| Platform                  | OS token | Arch token | Archive filename example            |
| ------------------------- | -------- | ---------- | ----------------------------------- |
| macOS 12+ (Apple Silicon) | `darwin` | `arm64`    | `horus-v1.2.3-darwin-arm64.tar.gz`  |
| macOS 12+ (Intel)         | `darwin` | `x86_64`   | `horus-v1.2.3-darwin-x86_64.tar.gz` |
| Linux ARM64               | `linux`  | `arm64`    | `horus-v1.2.3-linux-arm64.tar.gz`   |
| Linux x86_64              | `linux`  | `x86_64`   | `horus-v1.2.3-linux-x86_64.tar.gz`  |

- The arch token uses Homebrew conventions (`arm64`, `x86_64`).
- `amd64` is **not** used in Homebrew archive names; it maps to `x86_64`.
- Windows is out of scope for Homebrew.

## 2. Release archive filenames

Each release must produce one archive per supported platform:

```text
horus-v<VERSION>-<OS>-<ARCH>.tar.gz
```

Where:

- `<VERSION>` is the semver release version without the leading `v` (e.g. `1.2.3`).
- `<OS>` is `darwin` or `linux`.
- `<ARCH>` is `arm64` or `x86_64`.

For release `v1.2.3` the required set is:

```text
horus-v1.2.3-darwin-arm64.tar.gz
horus-v1.2.3-darwin-x86_64.tar.gz
horus-v1.2.3-linux-arm64.tar.gz
horus-v1.2.3-linux-x86_64.tar.gz
```

These platform archives are **additive** to the existing direct-download executable `horus-vX.Y.Z` and its `.sha256` file used by the curl installer. The curl installer path must remain unchanged.

## 3. Archive internal layout

Each archive must unpack to a single root directory named `horus/` containing the executable at `bin/horus`:

```text
horus-v1.2.3-darwin-arm64.tar.gz
└── horus/
    └── bin/
        └── horus
```

Requirements:

- `horus/bin/horus` is the same self-contained Node.js executable produced by `pnpm --filter ./apps/horus build` (`apps/horus/dist/index.cjs`), renamed from `index.cjs` to `horus`.
- The file must have executable permissions (`chmod +x`) and a Node shebang (`#!/usr/bin/env node`).
- No other files are required inside the archive. Optional files (e.g. `LICENSE`, `README.md`) may be added later, but the formula must only depend on `horus/bin/horus`.

Example build step for the future release pipeline:

```bash
VERSION="1.2.3"
DIST_FILE="apps/horus/dist/index.cjs"
TMP=$(mktemp -d)
mkdir -p "$TMP/horus/bin"
cp "$DIST_FILE" "$TMP/horus/bin/horus"
chmod +x "$TMP/horus/bin/horus"
tar -czf "horus-v${VERSION}-darwin-arm64.tar.gz" -C "$TMP" horus
rm -rf "$TMP"
```

## 4. Checksum expectations

For every archive there must be a separate SHA-256 checksum file:

```text
horus-v<VERSION>-<OS>-<ARCH>.tar.gz.sha256
```

The checksum file contents must follow the `sha256sum` two-field format:

```text
<64-char-hex-sha256>  horus-v<VERSION>-<OS>-<ARCH>.tar.gz
```

For release `v1.2.3` the required checksum files are:

```text
horus-v1.2.3-darwin-arm64.tar.gz.sha256
horus-v1.2.3-darwin-x86_64.tar.gz.sha256
horus-v1.2.3-linux-arm64.tar.gz.sha256
horus-v1.2.3-linux-x86_64.tar.gz.sha256
```

A Homebrew formula should consume the **first whitespace-delimited token** of the `.sha256` file as the `sha256` value. The checksum must be verified before the formula installs the archive.

## 5. Binary name and path

- Inside the archive the executable is at **`horus/bin/horus`**.
- The Homebrew formula must install it so that the user-facing command is **`horus`**.
- Homebrew enters the archive's root directory (`horus/`) before running `install`, so the formula installs the executable with `bin.install "bin/horus"`.
- The binary still requires **Node.js 22+** at runtime, so the formula must declare `depends_on "node"`.

## 6. Required packaging smoke commands

Every archive must pass these commands after installation before a release is considered valid for Homebrew:

```bash
horus --version   # exits 0, output contains "horus <semver>"
horus --help      # exits 0, output contains "Usage: horus" and lists core commands
```

These are the minimum Homebrew packaging checks. The existing release checklist already requires additional commands (e.g. `horus setup --help`, `horus index --help`, `horus investigate --help`, `horus init`, `horus doctor`) and those remain in force for the direct-download artifact.

## 7. How the Homebrew formula should consume the artifact

The future formula should:

1. Declare `depends_on "node"`.
2. Select the correct `url` and `sha256` based on the user's OS and architecture from the release assets.
3. Download `horus-v<VERSION>-<OS>-<ARCH>.tar.gz`.
4. Verify the SHA-256 against `horus-v<VERSION>-<OS>-<ARCH>.tar.gz.sha256`.
5. Install `bin/horus` from the extracted archive (Homebrew links it as `horus`).
6. Run the packaging smoke commands in `test do`.

Illustrative formula shape for HOR-124 (not a real formula file):

```ruby
class Horus < Formula
  desc "Local-first, source-aware incident investigation engine"
  homepage "https://horus.sh"
  version "1.2.3"
  license "MIT"

  depends_on "node"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/meritt-dev/horus/releases/download/v1.2.3/horus-v1.2.3-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256"
    else
      url "https://github.com/meritt-dev/horus/releases/download/v1.2.3/horus-v1.2.3-darwin-x86_64.tar.gz"
      sha256 "PLACEHOLDER_SHA256"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/meritt-dev/horus/releases/download/v1.2.3/horus-v1.2.3-linux-arm64.tar.gz"
      sha256 "PLACEHOLDER_SHA256"
    else
      url "https://github.com/meritt-dev/horus/releases/download/v1.2.3/horus-v1.2.3-linux-x86_64.tar.gz"
      sha256 "PLACEHOLDER_SHA256"
    end
  end

  def install
    bin.install "bin/horus"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/horus --version")
    assert_match "Usage: horus", shell_output("#{bin}/horus --help")
  end
end
```

## Deferrals

- **Archive generation in `scripts/release.sh`** — the current script continues to produce the bare `horus-vX.Y.Z` executable and its `.sha256` file for the curl installer. The platform archive build step is documented here and can be added to the release pipeline in HOR-125 or a follow-up release-automation ticket.
- **Homebrew tap repository and formula** — the formula is implemented in HOR-124. Pushing the `homebrew-tap` directory to `meritt-dev/homebrew-tap` and uploading the platform archives to the GitHub release are deferred until Mohammad approves publishing.
- **Automation of per-platform builds** — the contract assumes a single cross-platform Node.js executable; if native per-platform compilation is introduced later, the platform matrix in section 1 must be updated, but the archive layout and checksum contract stay the same.

## References

- [`docs/install.md`](./install.md) — existing curl installer and direct-download paths.
- [`docs/release-checklist.md`](./release-checklist.md) — full release validation commands.
- [`scripts/release.sh`](../scripts/release.sh) — current GitHub Release artifact generation.
- [`apps/horus/package.json`](../apps/horus/package.json) — source of the bundled `dist/index.cjs` executable.
