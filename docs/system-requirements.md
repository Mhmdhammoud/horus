# Horus System Requirements

> Audited from source — not guessed. Every claim below is traceable to a specific file.

---

## Quick answer: minimum to run `horus`

| Dependency | Version | Why |
|---|---|---|
| **Node.js** | ≥ 22 | The CLI is a bundled Node.js CJS executable (`apps/horus/dist/index.cjs`). Node runs it. |
| **bash** | any | The curl installer uses `#!/usr/bin/env bash` and bash-specific syntax. |
| **curl** | any | Required only for the one-line install path. |
| **shasum** (macOS) or **sha256sum** (Linux) | any | The installer and release scripts verify binary checksums. |
| **git** | any | Used by `horus` for repo root detection and change evidence (`git rev-parse`, `git diff`, `git log`). |

Everything else is optional.

---

## 1. Hard required system dependencies

### Node.js ≥ 22

**Source:** `package.json:7` → `"engines": { "node": ">=22" }`, `apps/horus/package.json:19`.

The Horus CLI is distributed as a self-contained bundled CJS file (`apps/horus/dist/index.cjs`).
It has a `#!/usr/bin/env node` shebang and is installed as an executable to `/usr/local/bin/horus` or `~/.local/bin/horus`.
At runtime, Node.js executes it. Without Node, the binary silently fails or is not executable in a meaningful way.

The Homebrew formula (`homebrew-tap/Formula/horus.rb:8`) lists `depends_on "node"` explicitly.

**Minimum version:** 22. The codebase uses `fetch` (Node 18 global) and ESM/CJS interop patterns that require at least 20, but `engines` pins to 22.

**Install options:**
```sh
# macOS
brew install node

# Linux
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Recommended: use nvm or fnm to manage versions
```

### bash

**Source:** `scripts/release.sh:1` → `#!/usr/bin/env bash`. `scripts/smoke-test.sh:1` → same.

The one-line curl installer is a bash script (not POSIX sh). It uses bash-specific constructs: `${BASH_SOURCE[0]}`, `[[ ]]` conditionals, `set -euo pipefail`.

**WSL / Linux:** bash is typically pre-installed.
**macOS:** bash 3.2 ships with macOS by default. Homebrew bash (5.x) is not required.

### curl

**Source:** Only needed to run `curl -fsSL https://horus.sh/install.sh | bash`.

Not needed after install. Not used by the CLI at runtime.

### shasum (macOS) / sha256sum (Linux)

**Source:** `scripts/release.sh:48-56` and `scripts/homebrew/build-archives.sh:31-40`.

The installer script (and all release scripts) run a checksum before installing the binary. On macOS, `shasum -a 256` is used; on Linux, `sha256sum`. The release scripts abort with a clear error if neither is found.

Both tools are pre-installed on macOS and standard Linux distributions.

### git

**Source:** `packages/core/src/git.ts:1` → `spawnSync('git', [...])`.
Also: `packages/connectors/src/git/provider.ts`, `packages/engine/src/git-collector.ts`, `packages/cli/src/commands/connect.ts:659` → `execFileSync('git', ['ls-files', '--error-unmatch', ...])`.

Horus shells out to `git` for:
- Finding the repo root (`git rev-parse --git-dir`)
- Listing changed files (`git diff --name-status`)
- Listing commits (`git log --format=...`)
- Checking if a file is tracked (`git ls-files --error-unmatch`)
- Contributor lookups and blame attribution

Without `git`, `horus doctor`, `horus changes`, `horus what-changed`, `horus blast-radius`, and most investigation features produce empty or degraded output. The doctor check reports "not in a git repository" as a warning.

**Minimum version:** any modern git (2.x). No advanced features required.

---

## 2. Optional but feature-dependent dependencies

### Postgres 16

**Source:** `docker-compose.yml:4` → `image: postgres:16-alpine`. `packages/core/src/config.ts:14` → `DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus'`. `packages/db/package.json:12` → `"postgres": "^3.4.5"`.

Postgres stores Horus investigation state: incidents, hypotheses, evidence, timelines, postmortems.

**Which commands need it:** `horus investigate`, `horus onboard`, `horus postmortem`, `horus replay`, and all commands that persist or read investigation data. `horus doctor` and `horus setup` probe it and report a **blocking failure** if unreachable.

**How Horus connects:** Pure npm `postgres` driver (no `psql` binary required). The CLI connects over TCP to the configured URL.

**Default URL:** `postgresql://horus:horus@localhost:5433/horus`
**Env var override:** `DATABASE_URL`
**Config key:** `database.url` in `horus.config.js`/`horus.config.ts`

**Schema:** The curl installer applies all migrations automatically. For manual setups:
```sh
# From the Horus repo (development):
pnpm db migrate

# Or with direct tsx:
DATABASE_URL=postgresql://... tsx packages/db/src/migrate.ts
```

**How to start locally (Docker):**
```sh
docker run -d --name horus-db \
  --restart unless-stopped \
  -e POSTGRES_USER=horus \
  -e POSTGRES_PASSWORD=horus \
  -e POSTGRES_DB=horus \
  -p 5433:5432 postgres:16

# Or, from the Horus repo:
docker compose up -d
```

**Failure mode:** `horus setup` and `horus readiness` show a red bullet. `horus investigate` fails immediately with a Postgres connection error.

**Note:** Postgres is classified as a hard dependency in `horus readiness` (blocking tier). However, `horus --help`, `horus --version`, and `horus doctor` still run without it.

### Docker / Docker Compose

**Source:** `docker-compose.yml`. Referenced in `setup.ts:81` and `readiness.ts:117` (in the "how to fix" hints printed when Postgres is unreachable).

Docker is not required by Horus itself. It is the **recommended way to run the Postgres dependency** locally. Any Postgres 16 instance (cloud, bare-metal, another container) works equally.

**What it runs:** only the `horus-postgres` service (plain Postgres 16, no pgvector).

**Minimum:** Docker Engine or Docker Desktop with Compose v2.

### horus-source Python package (source intelligence backend)

**Source:** `packages/connectors/src/axon/lifecycle.ts:10` → `const SOURCE_BINARY = 'horus-source'`. `packages/cli/src/commands/setup.ts:33` → `pip install horus-source`. `packages/core/src/version.ts:14` → `PINNED_SOURCE_VERSION = '1.0.7'`.

The `horus-source` binary is a Python-based service that:
1. Analyzes a repository into a code graph (`horus-source analyze .`)
2. Hosts the graph over HTTP (`horus-source host --port <port>`)

Horus CLI **shells out** to `horus-source` for lifecycle operations only (start/stop/analyze). Once running, all queries go over HTTP via `AxonHttpClient` (no further shell-outs for queries).

**Which commands need it:** `horus index`, `horus onboard`, `horus architecture`, `horus blast-radius`, `horus owner`, and any investigation that uses source-context evidence. Without it, investigations degrade gracefully — runtime evidence (logs, metrics, state) still works.

**Required Python version:** 3.11+ (stated in `horus setup` output: `python 3.11+ required`)

**Install:**
```sh
# Recommended — creates an isolated tool environment:
uv tool install horus-source

# Alternatives:
pip install horus-source
pipx install horus-source
```

The curl installer (`curl -fsSL https://horus.sh/install.sh | bash`) installs `horus-source` automatically when Python and uv or pip are available.

**Ensure on PATH:**
```sh
# pip user installs land here:
export PATH="$HOME/.local/bin:$PATH"
```

**Ports:** The host picks a free port in range **8420–8520** (`lifecycle.ts:99`). Each repository gets its own host instance. The port is recorded in `<repo>/.horus/spawned-host.json`.

**Pinned version:** `1.0.7`. `horus setup` rejects a mismatched version with a warning.

**State files written:**
- `<repo>/.horus/source/` — analyzed graph data
- `<repo>/.horus/spawned-host.json` — running host PID + port
- `<repo>/.horus/source-host.log` — host stdout/stderr

### pip / uv / pipx

Needed only to install `horus-source`. Any of these work:
- `uv tool install horus-source` (recommended — isolated environment)
- `pip install horus-source`
- `pipx install horus-source`

Not used by the Horus CLI at runtime.

### Python 3.11+

**Source:** `packages/cli/src/commands/setup.ts:32` → printed as a requirement when `horus-source` is not found.

Required only as the runtime for `horus-source`. Horus CLI is pure Node.js and does not use Python directly.

### AI provider CLIs (optional, for `--ai` flag)

**Source:** `packages/ai/src/local-providers.ts:15` → `LOCAL_PROVIDER_IDS = ['codex', 'claude', 'kimi', 'gemini', 'cursor']`. `packages/cli/src/commands/connect-ai.ts:38` → `spawnSync(id, ['--version'], ...)`.

Horus detects local AI provider CLIs on PATH by probing `<binary> --version`. They are used in `horus providers-doctor` to show availability, and can be configured as the preferred AI narrative provider via `horus connect ai`.

| Binary | Provider |
|---|---|
| `codex` | OpenAI Codex CLI |
| `claude` | Anthropic Claude Code |
| `kimi` | Moonshot Kimi |
| `gemini` | Google Gemini CLI |
| `cursor` | Cursor |

None are required. The `--ai` flag on investigation commands works with a cloud Anthropic API key (`ANTHROPIC_API_KEY` or configured via `horus connect ai`) without any local CLI installed.

---

## 3. Source intelligence backend — detailed requirements

| Item | Detail |
|---|---|
| **Binary name** | `horus-source` |
| **PyPI package** | `horus-source` |
| **Python runtime** | 3.11+ |
| **Install** | `pip install horus-source` or `uv pip install horus-source` |
| **Pinned version** | `1.0.7` (from `PINNED_SOURCE_VERSION` in `packages/core/src/version.ts`) |
| **Ports** | Free port in 8420–8520; one instance per repo |
| **Communication** | HTTP (the CLI uses `AxonHttpClient` / `SourceHttpClient` via `fetch`) |
| **Shell-outs** | Lifecycle only: `analyze`, `host --port`, `--version` |
| **State directories** | `<repo>/.horus/source/`, `<repo>/.horus/spawned-host.json`, `<repo>/.horus/source-host.log` |
| **Start command** | `horus index` (from inside the repo) |
| **Health check** | `GET /api/health` → 200 means ok |
| **Version check** | `GET /openapi.json` → `.info.version` |
| **Needs Docker** | No — pure Python process |
| **Needs Postgres** | No — separate from Horus Postgres |
| **Without it** | Investigations run with runtime evidence only; source context, symbol impact, queue stitching are unavailable |

---

## 4. Runtime connector requirements

All connectors communicate over the **network only**. No local client binaries (`mongosh`, `redis-cli`, `psql`) are needed. Horus uses npm packages for MongoDB and Redis, and raw `fetch` for Elasticsearch and Grafana.

### Elasticsearch (log evidence)

| Item | Detail |
|---|---|
| **Config key** | `connectors.elasticsearch` |
| **Required fields** | `indexPattern` or `indexPatterns` (at least one) |
| **Optional fields** | `url`, `urlEnv`, `username`, `usernameEnv`, `password`, `passwordEnv`, `serviceName`, `preset`, `fields` |
| **Default env vars** | `ES_URL`, `ES_USERNAME`, `ES_PASSWORD` |
| **Communication** | HTTP via Node `fetch` — `ElasticsearchClient` (`packages/connectors/src/elasticsearch/client.ts`) |
| **Local binary** | None required |
| **Auth** | HTTP Basic Auth (username + password) |
| **Presets** | `meritt` (default, pino-based) or `ecs` (Elastic Common Schema) |
| **Doctor check** | Checks `indexPattern` is set; marks as `warn` if not |
| **Common failures** | Wrong `preset` (field names don't match); unreachable URL; missing index pattern |

```json
{
  "connectors": {
    "elasticsearch": {
      "indexPattern": "my-service-*",
      "urlEnv": "ES_URL",
      "usernameEnv": "ES_USERNAME",
      "passwordEnv": "ES_PASSWORD"
    }
  }
}
```

### MongoDB (application state evidence)

| Item | Detail |
|---|---|
| **Config key** | `connectors.mongodb` |
| **Required fields** | `database` |
| **Optional fields** | `url`, `urlEnv`, `collections` |
| **Default env var** | `MONGODB_URL` |
| **npm package** | `mongodb` ^7.3.0 — native driver, no `mongosh` needed |
| **Communication** | MongoDB wire protocol via npm driver |
| **Local binary** | None required |
| **Auth** | Embedded in connection string (`mongodb://user:pass@host/db`) |
| **Read mode** | Read-only (`secondaryPreferred`); only `count`, `sample`, `aggregate` operations |
| **Doctor check** | Checks `url` is set; marks `warn` if missing |
| **Common failures** | Auth failure; wrong database name; `collections` allowlist too restrictive |

```json
{
  "connectors": {
    "mongodb": {
      "database": "mydb",
      "collections": ["orders", "payments"],
      "urlEnv": "MONGODB_URL"
    }
  }
}
```

### Grafana / Prometheus (metric evidence)

| Item | Detail |
|---|---|
| **Config key** | `connectors.grafana` |
| **Required fields** | `url` (or `urlEnv`) |
| **Optional fields** | `dashboard`, `dashboards`, `username`, `usernameEnv`, `password`, `passwordEnv` |
| **Default env vars** | `GRAFANA_URL`, `GRAFANA_USER`, `GRAFANA_PASSWORD` |
| **Communication** | HTTP via Node `fetch` — `GrafanaClient` (`packages/connectors/src/grafana/client.ts`) |
| **Prometheus** | All Prometheus queries route through Grafana's datasource proxy (`/api/datasources/proxy/uid/...`). No direct Prometheus access is required. |
| **Local binary** | None required |
| **Auth** | HTTP Basic Auth or API token in the password field |
| **Doctor check** | Checks `url` is set; marks `warn` if missing |
| **Common failures** | Grafana API token permissions too narrow; wrong datasource UID |

```json
{
  "connectors": {
    "grafana": {
      "dashboard": "your-dashboard-uid",
      "urlEnv": "GRAFANA_URL",
      "usernameEnv": "GRAFANA_USER",
      "passwordEnv": "GRAFANA_PASSWORD"
    }
  }
}
```

### Redis / BullMQ (queue state evidence)

| Item | Detail |
|---|---|
| **Config key** | `connectors.redis` |
| **Required fields** | `url` (or `urlEnv`) |
| **Optional fields** | `databases` (multi-DB with roles), `urlEnv` |
| **Default env var** | `REDIS_URL` |
| **npm package** | `ioredis` ^5.3.2 |
| **Communication** | Redis wire protocol via ioredis — no `redis-cli` needed |
| **Local binary** | None required |
| **Auth** | Embedded in URL (`redis://:password@host:6379`) |
| **Multi-DB support** | Each logical DB can have roles: `cache`, `state`, `locks`, `rate-limit`, `session`, `dedupe`, `bullmq`, `queues` |
| **BullMQ detection** | Scans `{prefix}:*:meta` keys to find queue names |
| **Doctor check** | Checks `url` is set; marks `warn` if missing |
| **Common failures** | Auth failure; wrong DB index; BullMQ prefix mismatch |

```json
{
  "connectors": {
    "redis": {
      "urlEnv": "REDIS_URL",
      "databases": [
        { "db": 0, "name": "cache", "roles": ["cache"] },
        { "db": 1, "name": "queues", "roles": ["bullmq"], "bullmq": { "prefix": "bull" } }
      ]
    }
  }
}
```

---

## 5. Installer requirements

### curl installer path

```sh
curl -fsSL https://horus.sh/install.sh | bash
```

**Required before running the installer:**

| Tool | Why |
|---|---|
| `bash` | The script uses bash syntax (`#!/usr/bin/env bash`, `${BASH_SOURCE[0]}`, `set -euo pipefail`) |
| `curl` | Downloads the installer and the binary |
| `shasum` (macOS) or `sha256sum` (Linux) | Verifies the binary checksum — script aborts if neither found |

**What the installer does:**
1. Detects platform (macOS/Linux, arm64/x86_64)
2. Downloads the pre-built binary from GitHub Releases
3. Verifies the SHA-256 checksum
4. Installs to `/usr/local/bin/horus` if writable, otherwise to `$HOME/.local/bin/horus`

**Permissions:** No `sudo` required if `~/.local/bin` is used. The installer tries `/usr/local/bin` first and falls back automatically.

**Node.js is NOT required before install** — the binary is pre-built. But it is required at runtime (the installed file is a Node.js CJS executable).

### npm install path

```sh
npm install -g @merittdev/horus
```

Requires Node.js ≥ 22 and npm. Installs the same bundled CJS binary.

### Homebrew path

```sh
brew install meritt-dev/tap/horus
```

Available on macOS and Linux. The formula (`homebrew-tap/Formula/horus.rb:8`) explicitly depends on `node`. Homebrew installs Node as a dependency if not already present.

---

## 6. Cross-platform support

### macOS

| Item | Status |
|---|---|
| arm64 (Apple Silicon) | Supported — pre-built binary in each release |
| x86_64 (Intel) | Supported — pre-built binary in each release |
| Homebrew | Available via `meritt-dev/tap/horus` |
| `shasum` | Pre-installed |
| `bash` | Pre-installed (3.2); works for the installer |
| Node 22 | Install via Homebrew (`brew install node`) or nvm |
| Python 3.11+ | Not pre-installed on macOS 14+; install via Homebrew or pyenv |

### Linux

| Item | Status |
|---|---|
| x86_64 | Supported — pre-built binary |
| arm64 | Supported — pre-built binary |
| `sha256sum` | Pre-installed on most distributions |
| `bash` | Pre-installed |
| Node 22 | Install via NodeSource or nvm |
| Python 3.11+ | Available via apt/dnf/pacman |

### WSL (Windows Subsystem for Linux)

WSL runs a Linux environment. All Linux instructions apply directly. No special handling is needed. The pre-built Linux binary is used.

### Windows native

**Not supported.** No Windows binary is built or released (`release.sh` only produces darwin and linux archives). The npm install (`npm install -g @merittdev/horus`) may work if Node.js is installed, but this is untested and unsupported.

---

## 7. `horus doctor` — current checks vs recommended additions

### What `horus doctor` currently checks

| Check | Status tier | Source |
|---|---|---|
| CLI version | pass (always) | `doctor.ts:48` |
| Git root detection | warn if not in git repo | `doctor.ts:54` |
| Local config (`.horus/config.json`) | warn if missing | `doctor.ts:66` |
| Source intelligence host URL configured | warn if not set | `doctor.ts:78` |
| Postgres reachability and schema | warn if unreachable or schema not applied | `doctor.ts:112` |
| Elasticsearch config (indexPattern set) | warn if not configured | `doctor.ts:167` |
| Grafana config (URL set) | warn | `doctor.ts:186` |
| MongoDB config (URL set) | warn | `doctor.ts:206` |
| Redis config (URL set) | warn | `doctor.ts:225` |

### Recommended additions to `horus doctor`

These items are checked by `horus setup` or `horus readiness` but not by `horus doctor`:

| Check | Why | How |
|---|---|---|
| Node.js version | Ensure runtime matches `engines: { node: ">=22" }` | `process.version` comparison |
| `horus-source` binary presence and version | Critical for source intelligence | Call `getSourceVersion()` (already in `packages/connectors/src/axon/lifecycle.ts`) |
| `git` binary on PATH | Required for most commands | `spawnSync('git', ['--version'])` |
| Global registry (`~/.horus/registry.json`) | Tells user if any projects are registered | Read and count entries |
| Source intelligence host live reachability | Doctor currently only checks if URL is configured, not if host is up | HTTP probe to `source.hostUrl` |
| ANTHROPIC_API_KEY / AI config | Let users know `--ai` flag won't work | `resolveAiSettings(config)` |
| `pip` / `uv` availability | Helps user install `horus-source` | `spawnSync('pip', ['--version'])` |

---

## 8. Dependency matrix

| Dependency | Type | Required for | Local binary? | Network? | Env var |
|---|---|---|---|---|---|
| **Node.js ≥ 22** | Hard | Running `horus` at all | Yes | No | — |
| **bash** | Hard | `curl \| bash` installer | Yes | No | — |
| **curl** | Hard | One-line install only | Yes | No | — |
| **shasum / sha256sum** | Hard | Install checksum verify | Yes | No | — |
| **git** | Hard | Most commands, repo detection | Yes | No | — |
| **Postgres 16** | Hard (for investigations) | Investigation state, postmortems, replay | No (npm driver) | TCP | `DATABASE_URL` |
| **Docker** | Optional | Easiest way to run Postgres locally | Yes (daemon) | — | — |
| **horus-source** | Optional | Source intelligence, onboarding, blast-radius | Yes (`horus-source`) | HTTP (self-hosted) | — |
| **Python 3.11+** | Optional | Running `horus-source` | Yes | No | — |
| **pip / uv** | Optional | Installing `horus-source` | Yes | No | — |
| **Elasticsearch** | Optional | Log evidence in investigations | No (fetch) | HTTPS | `ES_URL`, `ES_USERNAME`, `ES_PASSWORD` |
| **MongoDB** | Optional | State evidence in investigations | No (npm driver) | TCP | `MONGODB_URL` |
| **Grafana** | Optional | Metric evidence (Prometheus via proxy) | No (fetch) | HTTPS | `GRAFANA_URL`, `GRAFANA_USER`, `GRAFANA_PASSWORD` |
| **Redis** | Optional | Queue state evidence, BullMQ inspection | No (ioredis) | TCP | `REDIS_URL` |
| **codex / claude / kimi / gemini / cursor** | Optional | `--ai` flag with local CLI providers | Yes (each CLI) | No | — |
| **ANTHROPIC_API_KEY** | Optional | `--ai` flag with cloud Anthropic | No | HTTPS | `ANTHROPIC_API_KEY` |

---

## 9. Minimum required to run Horus

This is the smallest working Horus install:

```
Node.js ≥ 22
git (any version)
```

With just these, you can:
- `horus --version`, `horus --help`
- `horus doctor` (will warn about missing Postgres and connectors)
- `horus setup` (will show missing prerequisites)
- `horus init` (creates `.horus/config.json`)

**You cannot** run investigations or persist anything without Postgres.

---

## 10. Required for a working investigation

```
Node.js ≥ 22
git
Postgres 16 (local via Docker or remote)
```

Apply the schema:
```sh
# From the Horus repo:
pnpm db migrate

# Or set DATABASE_URL to your instance and run:
DATABASE_URL=postgresql://... tsx packages/db/src/migrate.ts
```

Then `horus investigate "my incident hint"` will run. Evidence quality depends on which connectors are configured.

---

## 11. Required for full local development

```
Node.js ≥ 22
pnpm@11.5.0
git
Docker (for local Postgres via docker compose up -d)
Python 3.11+ with pip or uv (for horus-source)
```

```sh
# 1. Start Postgres
docker compose up -d

# 2. Install Node deps
pnpm install

# 3. Apply schema
pnpm db migrate

# 4. Install source intelligence backend
pip install horus-source==1.0.7

# 5. Build the CLI
pnpm --filter ./apps/horus build

# 6. Verify
node apps/horus/dist/index.cjs --version
node apps/horus/dist/index.cjs setup
```

---

## 12. "Do I need X?"

| Dependency | Do I need it? |
|---|---|
| **Postgres** | Yes, for any investigation, postmortem, or replay. Use Docker or a remote instance. No local `psql` binary needed. |
| **Docker** | Only if you want the easiest way to run Postgres locally. Any Postgres 16 instance works. |
| **npm** | Only if you install Horus via `npm install -g @merittdev/horus`. Not needed at runtime. |
| **pnpm** | Only if you are building Horus from source. Not needed for end-user installs. |
| **uv** | Only to install `horus-source` if you prefer uv over pip. Either works. |
| **pip** | Only to install `horus-source`. Not used by the CLI at runtime. |
| **Python** | Only as the runtime for `horus-source`. Horus CLI is Node.js only. |
| **bash** | Only for the one-line curl installer. Not needed after install. |
| **curl** | Only for the one-line installer. Not needed after install. |
| **git** | Yes — always. Used for repo root detection and change evidence. |
| **Redis** | Only if your app uses Redis/BullMQ and you want queue-state evidence in investigations. |
| **MongoDB** | Only if your app uses MongoDB and you want state evidence. |
| **Elasticsearch** | Only if your app ships logs to Elasticsearch and you want log evidence. |
| **Grafana / Prometheus** | Only if you have Grafana and want metric evidence. Prometheus is not accessed directly. |

---

## 13. Files and directories Horus creates

| Path | Purpose |
|---|---|
| `/usr/local/bin/horus` or `~/.local/bin/horus` | The installed CLI binary |
| `~/.horus/registry.json` | Global project name → config path index |
| `<repo>/.horus/config.json` | Per-repo config (created by `horus init`) |
| `<repo>/.horus/secrets.local.json` | Locally stored secrets (API keys, gitignored) |
| `<repo>/.horus/source/` | Source intelligence graph data (written by `horus-source`) |
| `<repo>/.horus/spawned-host.json` | PID + port of the running `horus-source` host |
| `<repo>/.horus/source-host.log` | stdout/stderr from the `horus-source` host process |

---

## 14. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `horus: command not found` after install | Binary landed in `~/.local/bin` which is not on PATH | `export PATH="$HOME/.local/bin:$PATH"` and add to shell profile |
| `horus setup` reports "Postgres unreachable" | Postgres not running or wrong port | `docker run -d --name horus-db -e POSTGRES_USER=horus -e POSTGRES_PASSWORD=horus -e POSTGRES_DB=horus -p 5433:5432 postgres:16` |
| `horus setup` reports schema not applied | Migrations not run | `pnpm db migrate` from the Horus repo |
| `horus setup` reports "source intelligence backend not found" | `horus-source` not on PATH | `pip install horus-source` then `export PATH="$HOME/.local/bin:$PATH"` |
| `horus setup` reports "version mismatch" | `horus-source` version doesn't match `1.0.7` | `pip install --upgrade horus-source==1.0.7` |
| `horus investigate --ai` produces no narrative | `ANTHROPIC_API_KEY` not set, no AI provider configured | `horus connect ai` or `export ANTHROPIC_API_KEY=sk-ant-...` |
| `horus onboard` fails with "source-intelligence host unreachable" | `horus index` not run for this repo, or host stopped | `cd <repo> && horus index` |
| ES connector shows "failed" in investigation | Wrong field preset, timestamp field, or index pattern | See `docs/elasticsearch-field-mapping.md` |
| `Cannot find module '../dist/babel.cjs'` in `horus setup` | Using a `.ts` config with the built binary (jiti/babel issue) | Use `horus.config.js` (plain JS) instead of `horus.config.ts` |
