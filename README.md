<p align="center">
  <img src="https://meritt-dev-assets.s3.eu-central-1.amazonaws.com/public/horus-logo-dark-20260614171147.svg" width="72" alt="Horus" />
</p>

# Horus

**Understand what happened.**

Horus turns logs, metrics, traces, queues, databases, and code into a deterministic incident report.

CLI-only. Read-only against production systems. Horus never writes to your infrastructure.

**Website:** [horus.sh](https://horus.sh)

```bash
curl -fsSL https://horus.sh/install.sh | bash
```

---

## What Horus does

Horus reads from your existing systems and reconstructs the incident through evidence, correlation, and reasoning.

It does not dump thousands of logs. It connects runtime signals to source context and returns a **deterministic report** — root cause, confidence, supporting evidence, contradictions, and recommended actions. Evidence before inference. The report is the product.

Every incident leaves evidence.

## What Horus is not

|                   |                            |
| ----------------- | -------------------------- |
| **Monitoring**    | Detects problems           |
| **Observability** | Shows signals              |
| **Horus**         | Reconstructs what happened |

Horus is not another dashboard, alerting tool, or log viewer. It sits on top of the systems you already use.

> Monitoring detects. Observability shows. Horus reconstructs.

## How it works

**Evidence in. Explanation out.**

```
Runtime Evidence  →  Investigation Engine  →  Investigation Report
```

| Runtime Evidence | Investigation Engine | Investigation Report |
| ---------------- | -------------------- | -------------------- |
| Logs             | Correlation          | Root Cause           |
| Metrics          | Timeline             | Confidence           |
| Traces           | Hypotheses           | Evidence             |
| Queues           | Reconstruction       | Contradictions       |
| Databases        |                      | Recommended Actions  |

Pipeline: **Evidence → Correlation → Hypotheses → Timeline → Report**

Signals are easy. Correlation is hard. Every system sees a piece of the incident — Horus connects evidence across sources so the sequence of events becomes visible.

## Sources Horus investigates

Logs · Metrics · Traces · Redis · MongoDB · Elasticsearch · BullMQ · Git · Ownership

Every signal is read-only and project-scoped.

## Example

```bash
horus investigate \
  --project atlas-payments \
  --env production \
  "checkout latency spike"
```

```text
Collecting evidence...
✓ Elasticsearch
✓ Redis
✓ BullMQ
✓ Git
✓ Ownership

Building timeline...
✓ 14 events reconstructed

Correlating signals...
✓ 23 relationships identified

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Root Cause:     Redis connection pool exhaustion
Confidence:     82%

Supporting Evidence:
  • Deploy #784
  • Queue backlog growth
  • Worker starvation
  • Request timeout increase

Owner:            payments-platform
Next Action:      Inspect worker concurrency changes
```

## Principles

**Read-only** — Horus never writes to your production systems. It collects evidence and leaves everything untouched.

**Deterministic first** — Evidence before inference. Reports are built from signals and source context, not generated explanations.

**Local-first** — Runs close to your infrastructure. Connectors read from your own clusters, not a hosted black box.

**Project-scoped** — Every investigation belongs to a specific project and environment. No global defaults, no accidental cross-talk.

## Capabilities

Under active development.

**Today**

- Elasticsearch evidence
- MongoDB evidence
- BullMQ evidence
- Source-code investigations
- Timeline generation
- Evidence correlation

**Coming next**

- Kubernetes evidence
- Trace reconstruction
- Incident replay
- Slack evidence ingestion

## Can I use Horus today?

The investigation engine runs end-to-end. Some surfaces require a local setup before they work — Postgres for the audit store, a source-intelligence host, and at least one configured runtime connector for live evidence.

| Feature                                           | Status      | Notes                                                                                     |
| ------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| Install (`curl` or direct download)               | Partial     | Builds and runs from source; public binary release not yet published                      |
| `horus init`                                      | Works today | Creates `.horus/config.json` and registers the project                                    |
| `horus doctor`                                    | Works today | Checks CLI, git root, config, and source-intelligence setup                               |
| `horus setup`                                     | Works today | Verifies prerequisites and guides fixes                                                   |
| Source indexing (`horus index`)                   | Partial     | Command works; requires a source-intelligence host running locally                        |
| `horus investigate`                               | Works today | Full deterministic report; requires Postgres + at least one connector or git history      |
| `horus replay`                                    | Works today | Re-renders a saved investigation from the audit store; no re-query                        |
| `horus postmortem`                                | Works today | Drafts an editable Markdown postmortem from a saved investigation                         |
| Runtime connectors (ES / Mongo / Grafana / Redis) | Partial     | Connectors exist; each requires a live instance and per-project connector config          |
| AI narrative (`--ai` flag on `investigate`)       | Partial     | Requires `ANTHROPIC_API_KEY`; falls back to deterministic output automatically on failure |
| Local AI provider bridge                          | Partial     | Provider detection works; execution requires a local model installed                      |

**Prerequisites before Horus works end-to-end:**

- Postgres 16 (audit store) — `docker compose up -d` starts it
- At least one runtime connector configured via `horus connect <type>`
- Source-intelligence host running locally for source-aware commands (`horus index`, `horus explain`, `horus blast-radius`, `horus architecture`, `horus search`)

`horus replay` and `horus postmortem` work from the saved audit store and require neither live connectors nor a source-intelligence host.

---

## Architecture

Horus is organized in four layers:

**Source Intelligence**

- Built-in source-intelligence backend — code graph, semantic search, impact analysis, ownership (see below).

**Runtime Evidence**

- **Elasticsearch** — logs → synthesized error-signature evidence
- **MongoDB** — application/operational state
- **Grafana** — metrics via its datasource proxy
- **Redis / BullMQ** — queue runtime state
- **Git** — change history, ownership signals

**Investigation** (deterministic)

- **Queue Stitcher** — connects producer `queue.add(...)` to consumer `@Processor` handlers
- **Timeline Engine** — orders evidence into a sequence of events
- **Correlation Engine** — connects evidence across sources into incident threads

**Presentation**

- **Deterministic investigation report** — evidence, timeline, hypotheses, gap analysis, next actions
- **Optional AI narrative** — a later layer on top of the deterministic report

### Source intelligence is built into Horus

**Source intelligence is the expected intelligence layer used by Horus** — not an optional integration. Semantic search, impact analysis, ownership signals, change detection, and the process graph live in the source-intelligence backend; Horus does not duplicate them.

The **only** code-intelligence gap Horus owns is **queue-boundary stitching**: the source graph terminates around `queue.add(...)` and doesn't connect a producer to the consumer's `@Processor`. The stitcher synthesizes those producer → queue → worker edges.

> If the source-intelligence backend is unavailable, Horus can still collect runtime evidence, but source context, impact analysis, change analysis, and queue stitching become degraded.

Horus talks to the source-intelligence backend over **HTTP/MCP only** (no CLI shell-outs for queries). Run `horus index` in a repository to start and register its source-intelligence host.

## Configuration

The config model separates **code** from **runtime**:

- **Code belongs to the project** — `repositories[]`, each served by its own source-intelligence host.
- **Runtime belongs to the environment** — `environments[].connectors` (Elasticsearch, MongoDB, Grafana, Redis/BullMQ).

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

```bash
curl -fsSL https://horus.sh/install.sh | bash
horus --version
horus setup
```

The installer downloads the Horus CLI from GitHub Releases and installs it to your PATH. No npm step required.

### What the installer installs

| Component                             | Role                                                                          | Required |
| ------------------------------------- | ----------------------------------------------------------------------------- | -------- |
| **Horus CLI**                         | The `horus` command                                                           | Yes      |
| **Horus source-intelligence backend** | Enables `horus index`, `horus explain`, `horus changes`, `horus architecture` | Optional |

### Prerequisites

| Requirement           | Role                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Node.js 22+           | Horus CLI runtime (the installed binary needs Node.js)                                       |
| Postgres 16           | Investigation audit store — run locally via `docker compose up -d` or use a managed instance |
| Python 3.11+ + uv/pip | Required only for the source-intelligence backend                                            |

The installer **does not** configure Elasticsearch, MongoDB, Grafana, Redis, or any production system. Runtime connectors are added per-project after install via `horus connect`.

### Direct download (without the curl installer)

```bash
# Replace vX.Y.Z with the current release tag
curl -fsSL https://github.com/meritt-dev/horus/releases/download/v0.1.0/horus-v0.1.0 -o horus
chmod +x horus
sudo mv horus /usr/local/bin/horus
horus --version
```

**Package managers:** npm (`npm install -g @merittdev/horus`) is now live. The Homebrew tap (`meritt-dev/tap`) is prepared but still pending publish approval. See [docs/install.md](./docs/install.md#package-manager-installs) for the channel comparison and commands.

To **update** to a newer version, re-run the installer — it overwrites the binary and leaves your config untouched. To **uninstall**, see **[docs/install.md#uninstall](./docs/install.md#uninstall)** for what to remove and what to keep.

If something goes wrong after install, see **[docs/troubleshooting.md](./docs/troubleshooting.md)** for symptoms, likely causes, and exact fix commands covering: config missing, database not running, source-intelligence host unreachable, no indexed repo, connector not configured, and low-confidence reports.

## Local development / Usage

```bash
pnpm install
docker compose up -d                  # Postgres 16 on localhost:5433
pnpm build                            # builds apps/horus/dist/index.cjs

# Per repository: start the source-intelligence host and stitch queue boundaries
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

| Command                                                                     | What it does                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `horus status [--project --env]`                                            | Per-project/env connector-health matrix                               |
| `horus index --project <p> --env <e>`                                       | Build the queue map (stitcher) for a project                          |
| `horus investigate --project <p> --env <e> "<hint>"`                        | Full deterministic investigation report                               |
| `horus logs [service] --project <p> --env <e>`                              | Error-signature evidence (`--raw` for lines)                          |
| `horus state --project <p> --env <e>`                                       | MongoDB application-state evidence (read-only)                        |
| `horus metrics [hint] --project <p> --env <e>`                              | Grafana metrics evidence                                              |
| `horus explain <symbol>` · `blast-radius` · `architecture` · `what-changed` | Source-aware code intelligence (requires source-intelligence backend) |

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

`horus index` reuses an already-running source-intelligence host when one is healthy. Runtime connectors are added to the env block of `.horus/config.json` afterwards.

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
- Postgres + Drizzle — semantic search delegated to source-intelligence backend
- Built-in **source-intelligence backend**, over HTTP/MCP only
- Project/environment-scoped connectors; read-only against production
