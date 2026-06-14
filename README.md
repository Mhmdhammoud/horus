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

| | |
|---|---|
| **Monitoring** | Detects problems |
| **Observability** | Shows signals |
| **Horus** | Reconstructs what happened |

Horus is not another dashboard, alerting tool, or log viewer. It sits on top of the systems you already use.

> Monitoring detects. Observability shows. Horus reconstructs.

## How it works

**Evidence in. Explanation out.**

```
Runtime Evidence  →  Investigation Engine  →  Investigation Report
```

| Runtime Evidence | Investigation Engine | Investigation Report |
|---|---|---|
| Logs | Correlation | Root Cause |
| Metrics | Timeline | Confidence |
| Traces | Hypotheses | Evidence |
| Queues | Reconstruction | Contradictions |
| Databases | | Recommended Actions |

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

---

## Architecture

Horus is organized in four layers:

**Source Intelligence**
- **Axon** — the default source-intelligence backend (see below).

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

### Axon is the default source-intelligence backend

**Axon is the default and expected source-intelligence layer used by Horus** — not an optional integration. Semantic search, impact analysis, ownership signals, change detection, and the process graph live in Axon; Horus does not duplicate them.

The **only** code-intelligence gap Horus owns is **queue-boundary stitching**: Axon's graph terminates around `queue.add(...)` and doesn't connect a producer to the consumer's `@Processor`. The stitcher synthesizes those producer → queue → worker edges.

> If Axon is unavailable, Horus can still collect runtime evidence, but source context, impact analysis, change analysis, and queue stitching become degraded.

Horus talks to Axon over **HTTP/MCP only** (no CLI shell-outs for queries). Each repository points at an `axon host` indexing it.

## Configuration

The config model separates **code** from **runtime**:

- **Code belongs to the project** — `repositories[]`, each served by its own Axon host.
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
          axon: { hostUrl: 'http://127.0.0.1:8420' },
        },
      ],
      environments: [
        {
          name: 'production',
          readOnly: true,
          connectors: {
            elasticsearch: { indexPattern: 'atlas-payments-prod-*', serviceName: 'atlas-payments-prod' },
            mongodb: { database: 'atlas_payments_prod', collections: ['orders', 'payments', 'workers'] },
            grafana: {},
          },
        },
      ],
    },
  ],
  axon: { pinnedVersion: '1.0.1' },
  database: { url: process.env.DATABASE_URL ?? 'postgresql://horus:horus@localhost:5433/horus' },
});
```

**No connector runs without an explicit project/env scope** — there are no global connector defaults.

**Secrets are never committed.** Connector credentials are read from environment variables at runtime. Keep them in a gitignored file (e.g. `~/.horus.env`) and `source` it before running.

## Usage

```bash
pnpm install
docker compose up -d                  # Postgres 16 on localhost:5433
pnpm build                            # build the bundled `horus` binary

# Per repository: index its Axon graph + host it
axon analyze .
axon host --port 8420

source ~/.horus.env

node apps/horus/dist/index.js status
```

```bash
horus --help
horus help <command>
horus investigate --help
```

### Core commands

| Command | What it does |
|---|---|
| `horus status [--project --env]` | Per-project/env connector-health matrix |
| `horus index --project <p> --env <e>` | Build the queue map (stitcher) for a project |
| `horus investigate --project <p> --env <e> "<hint>"` | Full deterministic investigation report |
| `horus logs [service] --project <p> --env <e>` | Error-signature evidence (`--raw` for lines) |
| `horus state --project <p> --env <e>` | MongoDB application-state evidence (read-only) |
| `horus metrics [hint] --project <p> --env <e>` | Grafana metrics evidence |
| `horus explain <symbol>` · `blast-radius` · `architecture` · `what-changed` | Source-aware code intelligence (Axon) |

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

`horus index` reuses an already-running Axon host when one is healthy. Runtime connectors are added to the env block of `.horus/config.json` afterwards.

## Layout

```
packages/
  core/         evidence model, config schema + project/env resolution, version pins
  connectors/   provider contracts + Axon (HTTP/MCP) · Elasticsearch · Grafana · MongoDB · Git
  stitcher/     queue-boundary stitcher
  db/           Drizzle schema + migrations (plain Postgres, no pgvector)
  engine/       deterministic investigation pipeline (timeline, correlation, hypotheses, gaps)
  cli/          commander CLI
apps/horus/     composition root (bundled bin)
config/         horus.config.ts
```

## Foundation

- TypeScript monorepo (pnpm + Turborepo)
- Postgres + Drizzle — semantic search delegated to Axon
- **Axon** as the default source-intelligence backend, over HTTP/MCP only
- Project/environment-scoped connectors; read-only against production
