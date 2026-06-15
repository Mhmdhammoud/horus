# Horus Install

## Install

```sh
curl -fsSL https://horus.sh/install.sh | bash
```

The installer:

1. Detects your platform (macOS/Linux, arm64/amd64)
2. Chooses an install directory: `/usr/local/bin` if writable, otherwise `$HOME/.local/bin`
3. Downloads the pre-built Horus binary for your platform

## Verify

```sh
which horus
horus --version
horus --help
```

Expected output from `--version`:

```
horus 0.1.0
```

## What gets installed

| File | Purpose |
|------|---------|
| `/usr/local/bin/horus` (or `~/.local/bin/horus`) | Horus CLI binary |

## Requirements

- curl
- macOS 12+ or Linux (x86_64 or arm64)

## Next steps

- **Runtime connectors** (Elasticsearch, MongoDB, Grafana) — see [connector-setup.md](./connector-setup.md)
- **Local AI providers** (Codex, Claude CLI, Gemini, etc.) — see [provider-setup.md](./provider-setup.md)
- **Source intelligence** (code graph, ownership) — see [connector-setup.md](./connector-setup.md#source-intelligence)

## Uninstall

```sh
rm -f /usr/local/bin/horus ~/.local/bin/horus
```

---

## Troubleshooting

### `horus: command not found` after install

The installer places `horus` in `/usr/local/bin` if that directory is writable, otherwise in
`$HOME/.local/bin`. If your shell cannot find `horus`, the binary is likely in `~/.local/bin`
which may not be on your `PATH`.

**Fix:**

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Add that line to your shell profile (`~/.bashrc`, `~/.zshrc`, or `~/.profile`) to make it
permanent. Then open a new terminal and run `horus --version` to confirm.

**Verify which directory was used:**

```sh
ls -la ~/.local/bin/horus /usr/local/bin/horus 2>/dev/null
```

---

### Download or network failure

If `curl` fails or the download hangs, the installer exits with a non-zero code and prints an
error. Common causes:

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `curl: (6) Could not resolve host` | DNS or network issue | Check internet connectivity |
| `curl: (22) The requested URL returned error: 404` | Release not yet published | Check [github.com/meritt-dev/horus/releases](https://github.com/meritt-dev/horus/releases) for the latest tag |
| Download hangs indefinitely | Firewall blocking outbound HTTPS | Try from a different network or contact your network admin |

To retry a failed install, run the same command again:

```sh
curl -fsSL https://horus.sh/install.sh | bash
```

The installer overwrites any existing binary — it is safe to re-run.

---

### Unsupported platform or architecture

If the installer reports that no binary is available for your platform, you will see a message
similar to:

```
No pre-built binary available for linux/386.
Supported platforms: linux/amd64, linux/arm64, darwin/amd64, darwin/arm64.
```

**Options:**

1. **Build from source** — requires Node.js 22+ and pnpm:

   ```sh
   git clone https://github.com/meritt-dev/horus.git
   cd horus
   pnpm install --frozen-lockfile
   pnpm --filter ./apps/horus build
   # Binary is at apps/horus/dist/index.cjs
   node apps/horus/dist/index.cjs --version
   ```

2. **Run with Node directly** (no install needed):

   ```sh
   node apps/horus/dist/index.cjs investigate "your incident hint"
   ```

---

### Re-running the release smoke check

To verify a fresh install passes the full acceptance check without production credentials:

```sh
# Run directly from the repo:
./scripts/acceptance/release-smoke.sh

# Or pass --install to also run the curl install step first:
./scripts/acceptance/release-smoke.sh --install
```

All checks should print `✓`. If any print `✗`, the output includes the expected vs. received
value and the step that failed.

To test a locally built binary instead of the PATH `horus`:

```sh
./scripts/smoke-test.sh apps/horus/dist/index.cjs
```

---

### `setup` fails with "source-intelligence host unreachable"

`horus setup` checks that the Axon source-intelligence backend is reachable. This is not
required for basic CLI use — only for investigations that need code-level evidence.

To set up source intelligence, see [connector-setup.md](./connector-setup.md).

---

### Version mismatch

If `horus --version` returns an unexpected version after a reinstall, an older binary may be
shadowing the new one. Run:

```sh
which -a horus
```

and remove any stale copies before re-running the installer.
