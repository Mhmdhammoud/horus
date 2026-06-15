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

| File                                             | Purpose          |
| ------------------------------------------------ | ---------------- |
| `/usr/local/bin/horus` (or `~/.local/bin/horus`) | Horus CLI binary |

## Requirements

| Requirement             | Details                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| **Node.js 22+**         | The CLI is a self-contained Node.js executable — Node is required at runtime |
| **curl**                | Required only for the one-line installer                                     |
| **OS**                  | macOS 12+ or Linux (x86_64 or arm64)                                         |
| Python 3.11+ (optional) | Enables source-intelligence features (install via `pip install axoniq`)      |

## Next steps

- **Runtime connectors** (Elasticsearch, MongoDB, Grafana) — see [connector-setup.md](./connector-setup.md)
- **Local AI providers** (Codex, Claude CLI, Gemini, etc.) — see [provider-setup.md](./provider-setup.md)
- **Source intelligence** (code graph, ownership) — see [connector-setup.md](./connector-setup.md#source-intelligence)

## Update

Re-running the installer downloads and overwrites the current binary with the latest release.
Your config files and project data are not affected.

```sh
curl -fsSL https://horus.sh/install.sh | bash
```

Verify the new version afterwards:

```sh
horus --version
```

To update to a **specific version** instead of the latest, download the binary directly:

```sh
# Replace vX.Y.Z with the target version tag
VERSION=v0.1.0
PLATFORM=darwin-arm64    # or linux-amd64, linux-arm64, darwin-amd64
curl -fsSL "https://github.com/meritt-dev/horus/releases/download/${VERSION}/horus-${PLATFORM}" \
  -o horus
chmod +x horus
sudo mv horus /usr/local/bin/horus   # or ~/.local/bin/horus
horus --version
```

---

## Package manager installs

The recommended install path is still the curl installer above, but npm is now available for environments that prefer it. Homebrew remains pending the tap publishing step.

### npm (live)

Install Horus globally with npm:

```sh
npm install -g @merittdev/horus
horus --version
```

The npm package contains the same self-contained Node.js executable as the curl installer.

### Homebrew (pending approval)

Once the tap is published, install Horus with:

```sh
brew tap meritt-dev/tap
brew install horus
```

or directly:

```sh
brew install meritt-dev/tap/horus
```

### Choosing a channel

| Channel                    | Best for                                                           | Status                         |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| **curl / direct download** | Recommended; always points to the latest GitHub Release executable | Live                           |
| **npm**                    | Environments already using Node.js/npm; `npm update -g` semantics  | Live                           |
| **Homebrew**               | macOS/Linux users who prefer `brew upgrade` semantics              | Pending tap approval (HOR-124) |

All three channels install the same `horus` binary and leave your project config untouched.

---

## Uninstall

Horus places files in three locations. Remove only what you want to remove.

### 1. Remove the binary

```sh
rm -f /usr/local/bin/horus ~/.local/bin/horus
```

This is the only step needed to remove the `horus` command from your PATH.

### 2. Remove the global registry (optional)

`horus init` registers projects in a global registry at `~/.horus/registry.json`. To remove it:

```sh
rm -rf ~/.horus
```

This only affects project lookup by name (`--name <project>`). It does **not** remove any project-level config files.

### 3. Remove project-level config (per-repository — do this only if you want to fully reset a project)

Each repository initialized with `horus init` has a `.horus/config.json` file at its root. Remove it per-project if needed:

```sh
rm -rf /path/to/your-repo/.horus
```

> **Do not delete** `.horus/config.json` files unless you intend to reconfigure that project. They are project config, not installer state — removing them does not affect the Horus binary or other projects.

### What each file is

| File / directory                               | What it is                                             | Safe to delete?                              |
| ---------------------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| `/usr/local/bin/horus` or `~/.local/bin/horus` | The installed binary                                   | Yes — removes the `horus` command            |
| `~/.horus/registry.json`                       | Global project name → config path index                | Yes — you can re-register with `horus init`  |
| `<repo>/.horus/config.json`                    | Per-project config (created by `horus init`)           | Only if resetting that project               |
| `<repo>/horus.config.js`                       | User-authored global config (not created by installer) | Only if you created it and want to remove it |

For guidance on which files to commit and which to gitignore, see **[docs/gitignore-guide.md](./gitignore-guide.md)**.

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

| Symptom                                            | Likely cause                     | Fix                                                                                                           |
| -------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `curl: (6) Could not resolve host`                 | DNS or network issue             | Check internet connectivity                                                                                   |
| `curl: (22) The requested URL returned error: 404` | Release not yet published        | Check [github.com/meritt-dev/horus/releases](https://github.com/meritt-dev/horus/releases) for the latest tag |
| Download hangs indefinitely                        | Firewall blocking outbound HTTPS | Try from a different network or contact your network admin                                                    |

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

The acceptance script validates the minimum clean-environment command surface:

```sh
horus --version      # exits 0, prints "horus <semver>"
horus --help         # exits 0, lists core commands
horus init           # creates .horus/config.json in a temp dir
horus doctor         # prints "Horus readiness check" header and CLI version
```

To test a locally built binary instead of the PATH `horus`:

```sh
./scripts/smoke-test.sh apps/horus/dist/index.cjs
```

---

### `setup` fails with "source-intelligence host unreachable"

`horus setup` checks that the Horus source-intelligence backend is reachable. This is not
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
