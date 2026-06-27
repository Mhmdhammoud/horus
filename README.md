<p align="center">
  <img src="https://meritt-dev-assets.s3.eu-central-1.amazonaws.com/public/horus-logo-dark-20260614171147.svg" width="72" alt="Horus" />
</p>

# Horus

**Understand what happened.**

Open-source incident investigation. Horus connects Elasticsearch, Sentry, Grafana, MongoDB, Postgres, Redis, BullMQ, and source intelligence into deterministic reports — installable today.

CLI-only. Read-only against production systems. Horus never writes to your infrastructure.

**Website:** [horus.sh](https://horus.sh) · **Source:** [github.com/meritt-dev/horus](https://github.com/meritt-dev/horus)

```bash
curl -fsSL https://horus.sh/install.sh | bash
npm install -g @merittdev/horus
brew install meritt-dev/tap/horus
```

Homebrew tap is live through meritt-dev/tap.

---

## What Horus does

Horus reads from your existing systems and reconstructs the incident through evidence, correlation, and ranked hypotheses.

It does not dump thousands of logs. It connects runtime signals to source context and returns a **deterministic report** — suspected causes (ranked), hypotheses, evidence, gaps, and next actions. Evidence before inference. Optional `--ai` adds an Anthropic narrative on top.

Every incident leaves evidence.

## What Horus is not

| | |
|---|---|
| **Monitoring** | Detects problems |
| **Observability** | Shows signals |
| **Horus** | Reconstructs what happened |

Horus is not another dashboard, alerting tool, or log viewer. It sits on top of the systems you already use.

> Monitoring detects. Observability shows. Horus reconstructs.

## Getting started

```bash
horus setup
horus init
horus index
horus connect elasticsearch   # optional runtime connectors
horus investigate "checkout latency spike"
horus investigations          # list saved IDs
horus replay <id>
horus postmortem <id>
```

Horus source intelligence requires a local code-graph host (the curl installer attempts to install it). Postgres is required for the audit store.

## How it works

**Evidence in. Explanation out.**

| Runtime + Source | Investigation Engine | Investigation Report |
|---|---|---|
| Elasticsearch logs · Sentry errors | Correlation | Suspected causes (ranked) |
| Grafana metrics | Timeline | Hypotheses + confidence |
| MongoDB · Postgres · Redis state | Cause ranking | Evidence + gaps |
| BullMQ queue runtime | | Next actions |
| Source graph + git | | |

Pipeline: **Evidence → Correlation → Hypotheses → Timeline → Report**

## Sources Horus investigates

Elasticsearch · Sentry · Grafana · MongoDB · Postgres · Redis · BullMQ · Git changes · Source graph · Queue map · Ownership

Trace reconstruction is not shipped yet. Connectors are read-only and project-scoped.

## Example output (illustrative)

```bash
horus investigate \
  --project atlas-payments \
  --env production \
  "checkout latency spike"
```

```text
# Investigation inv-347
Hint: checkout latency spike

## Suspected causes (ranked)
1. [0.82 / high] Redis connection pool exhaustion [↑ queue]

## Hypotheses
  [supported] [0.78] queue: backlog growth preceded latency spike

## Evidence gaps
  - queue runtime state: worker heartbeat unavailable

## Evidence
- ev-01 [elasticsearch/error] Request timeout increase
- ev-04 [bullmq/queue] checkout-jobs backlog growth

## Next actions
- Inspect worker concurrency changes in deploy #784
```

## Principles

**Read-only** — Horus never writes to your production systems.

**Deterministic first** — The engine is deterministic; optional `--ai` adds an Anthropic narrative.

**Local-first** — Connectors read from your own clusters, not a hosted black box.

**Project-scoped** — Every investigation belongs to a specific project and environment.

## Capabilities

Installable today. More connectors and AI providers are in progress.

**Today**

- Elasticsearch logs
- Sentry errors
- Grafana metrics
- MongoDB / Postgres / Redis state
- BullMQ queue evidence
- Source intelligence (code graph)
- Timeline generation
- Evidence correlation
- Investigation replay
- Postmortem drafts

**Coming next**

- Kubernetes evidence
- Distributed trace reconstruction
- Slack evidence ingestion
- Local AI provider execution

---

## Architecture

Horus is organized in four layers:

**Source Intelligence**

- Horus source intelligence backend — code graph, semantic search, impact analysis, ownership.

**Runtime Evidence**

- **Elasticsearch** — logs → synthesized error-signature evidence
- **Sentry** — grouped exceptions (issues) → same error-signature / direct-seed path as logs
- **MongoDB / Postgres** — application/operational state
- **Grafana** — metrics via its datasource proxy
- **Redis / BullMQ** — cache & queue runtime state
- **Git** — change history, ownership signals

**Investigation** (deterministic)

- **Queue Stitcher** — connects producer `queue.add(...)` to consumer `@Processor` handlers
- **Timeline Engine** — orders evidence into a sequence of events
- **Correlation Engine** — connects evidence across sources into incident threads

**Presentation**

- **Deterministic investigation report** — evidence, timeline, hypotheses, gap analysis, next actions
- **Optional AI narrative** — a later layer on top of the deterministic report

### Source intelligence is built into Horus

**Source intelligence is the expected intelligence layer used by Horus** — not an optional integration. Semantic search, impact analysis, ownership signals, change detection, and the process graph live in the Horus source intelligence backend; Horus does not duplicate them.

The **only** code-intelligence gap Horus owns is **queue-boundary stitching**: the source graph terminates around `queue.add(...)` and doesn't connect a producer to the consumer's `@Processor`. The stitcher synthesizes those producer → queue → worker edges.

> If the Horus source intelligence backend is unavailable, Horus can still collect runtime evidence, but source context, impact analysis, change analysis, and queue stitching become degraded.

Horus talks to the source intelligence backend over **HTTP/MCP only** (no CLI shell-outs for queries). Run `horus index` in a repository to start and register its source intelligence host.

## Configuration

The config model separates **code** from **runtime**:

- **Code belongs to the project** — `repositories[]`, each served by its own source intelligence host.
- **Runtime belongs to the environment** — `environments[].connectors` (Elasticsearch, Sentry, MongoDB, Postgres, Grafana, Redis/BullMQ).

```ts
// config/horus.config.ts
export default defineConfig({
  projects: [
    {
      name: 'atlas-payments',
      repositories: [
        {
          name: 'atlas-payments',
          path: '/repos/atlas-payments',
          source: { hostUrl: 'http://127.0.0.1:8420' },
        },
      ],
      environments: [
        {
          name: 'production',
          readOnly: true,
          connectors: {
            elasticsearch: {
              indexPattern: 'atlas-payments-prod-*',
              serviceName: 'atlas-payments-prod',
            },
            mongodb: {
              database: 'atlas_payments_prod',
              collections: ['orders', 'payments', 'workers'],
            },
            grafana: {},
          },
        },
      ],
    },
  ],
  database: {
    url: process.env.DATABASE_URL ?? 'postgresql://horus:horus@localhost:5433/horus',
  },
});
```

**No connector runs without an explicit project/env scope** — there are no global connector defaults.

**Secrets are never committed.** Connector credentials are read from environment variables at runtime. Keep them in a gitignored file (e.g. `~/.horus.env`) and `source` it before running. For a full reference on which Horus files to commit and which to gitignore, see **[docs/gitignore-guide.md](./docs/gitignore-guide.md)**.

## Install

See **[docs/install.md](./docs/install.md)** for full install, update, and uninstall instructions.

```bash
curl -fsSL https://horus.sh/install.sh | bash
npm install -g @merittdev/horus
brew install meritt-dev/tap/horus
horus --version
horus setup
```

The curl installer downloads the Horus CLI from GitHub Releases and attempts to install the Horus source intelligence backend. All three channels install the same `horus` binary.

### What the installer installs

| Component | Role | Required |
| --- | --- | --- |
| **Horus CLI** | The `horus` command | Yes |
| **Horus source intelligence backend** | Enables `horus index`, `horus explain`, `horus changes`, `horus architecture` | Optional |

### Prerequisites

| Requirement | Role |
| --- | --- |
| Node.js 22+ | Horus CLI runtime (the installed binary needs Node.js) |
| Postgres 16 | Investigation audit store — run locally via `docker compose up -d` or use a managed instance |
| Python 3.11+ + uv/pip | Required only for the Horus source intelligence backend |

The installer **does not** configure Elasticsearch, MongoDB, Grafana, Redis, or any production system. Runtime connectors are added per-project after install via `horus connect`.

### Direct download (without the curl installer)

```bash
# Replace vX.Y.Z with the current release tag
curl -fsSL https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0 -o horus
chmod +x horus
sudo mv horus /usr/local/bin/horus
horus --version
```

To **update** to a newer version, re-run the installer — it overwrites the binary and leaves your config untouched. To **uninstall**, see **[docs/install.md#uninstall](./docs/install.md#uninstall)**.

If something goes wrong after install, see **[docs/troubleshooting.md](./docs/troubleshooting.md)**.

## Local development

```bash
pnpm install
docker compose up -d                  # Postgres 16 on localhost:5433
pnpm build                            # builds apps/horus/dist/index.cjs

# Per repository: start the source intelligence host and stitch queue boundaries
horus index

source ~/.horus.env

node apps/horus/dist/index.cjs status
```

**Verify the full v0.1 user path (init → investigate → replay → postmortem):**

```bash
# No-services startup check (version, help, doctor):
./scripts/smoke-test.sh apps/horus/dist/index.cjs

# Full end-to-end flow (requires Postgres from docker compose up -d):
./scripts/e2e-smoke.sh apps/horus/dist/index.cjs
```

```bash
horus --help
horus help <command>
horus investigate --help
```

### Core commands

| Command | What it does |
| --- | --- |
| `horus status [--project --env]` | Per-project/env connector-health matrix |
| `horus index --project <p> --env <e>` | Build the queue map (stitcher) for a project |
| `horus investigate --project <p> --env <e> "<hint>"` | Full deterministic investigation report |
| `horus logs [service] --project <p> --env <e>` | Error-signature evidence (`--raw` for lines) |
| `horus state --project <p> --env <e>` | MongoDB application-state evidence (read-only) |
| `horus metrics [hint] --project <p> --env <e>` | Grafana metrics evidence |
| `horus explain <symbol>` · `blast-radius` · `architecture` · `what-changed` | Source-aware code intelligence (requires source intelligence backend) |

## Local project workflow (git-style)

A repo carries a `.horus/config.json` (discovered by walking up from the working directory, like `.git`), and a global registry (`~/.horus/registry.json`) lets `--name` resolve a project from anywhere.

```bash
horus setup

cd /repos/atlas-payments
horus index

horus investigate "checkout latency spike"
horus investigate --name atlas-payments "checkout latency spike"
horus projects
```

`horus index` reuses an already-running source intelligence host when one is healthy. Runtime connectors are added to the env block of `.horus/config.json` afterwards.

## Layout

```
packages/
  core/         evidence model, config schema + project/env resolution, version pins
  connectors/   provider contracts + source intelligence (HTTP/MCP) · Elasticsearch · Grafana · MongoDB · Git
  stitcher/     queue-boundary stitcher
  db/           Drizzle schema + migrations (plain Postgres, no pgvector)
  engine/       deterministic investigation pipeline (timeline, correlation, hypotheses, gaps)
  cli/          commander CLI
apps/horus/     composition root (bundled bin)
config/         horus.config.ts
```

## Foundation

- TypeScript monorepo (pnpm + Turborepo)
- Postgres + Drizzle — semantic search delegated to source intelligence backend
- Built-in **Horus source intelligence backend**, over HTTP/MCP only
- Project/environment-scoped connectors; read-only against production
