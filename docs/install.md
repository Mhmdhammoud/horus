# Horus Install

> **Status: Preview Bootstrap**
> This installer is a temporary bootstrap backed by the [Axon fork](https://github.com/Mhmdhammoud/axon).
> It installs a `horus` shim that wraps Axon until the full Horus CLI rebrand is complete.

## Install

```sh
curl -fsSL https://horus.sh/install.sh | bash
```

The installer:

1. Detects your platform (macOS/Linux, arm64/amd64)
2. Chooses an install directory: `/usr/local/bin` if writable, otherwise `$HOME/.local/bin`
3. Downloads a pre-built Axon binary from the fork's GitHub releases, or builds from source if Go is available
4. Writes a `horus` shim that wraps the installed Axon binary

## Verify

```sh
which horus
horus --version
horus --help
```

Expected output:

```
horus 0.0.0-preview (preview bootstrap → axon)
```

## What gets installed

| File | Purpose |
|------|---------|
| `/usr/local/bin/horus` (or `~/.local/bin/horus`) | Shell shim that delegates to `axon` |
| `/usr/local/bin/axon` (or `~/.local/bin/axon`) | Axon binary from `Mhmdhammoud/axon` |

## Requirements

- curl or wget
- (optional) Go ≥ 1.21 — needed only if no pre-built release exists for your platform

## Local dev test

```sh
cd apps/web && pnpm dev
# then in another terminal:
curl -fsSL http://localhost:3000/install.sh | bash
which horus
horus --version
horus --help
```

## Uninstall

```sh
rm -f /usr/local/bin/horus ~/.local/bin/horus
rm -f /usr/local/bin/axon  ~/.local/bin/axon
```

## Limitations (preview)

- `horus` is a thin wrapper around `axon`. All flags and commands pass through to Axon.
- If Axon has no pre-built binary for your platform and Go is not installed, a placeholder shim is installed instead. The shim prints a message and exits — it does not call Axon.
- This installer has no checksum verification. A signed, checksummed release is coming with the full rebrand.
- Homebrew and other package managers are not supported yet.

## What's next

The Axon fork will be rebranded as the native Horus CLI. When that lands:

- The bootstrap wrapper is replaced with a real `horus` binary
- A checksummed release pipeline is added
- Homebrew tap + `npm install -g horus` support is added
- This install doc is updated to drop the "preview" caveat

See the [architecture doc](./architecture.md) for how Horus and Axon relate.
