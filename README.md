# Horus

Local-first, source-aware production-incident investigation engine. Given an incident,
it answers **what happened, why, and where to look next** — by correlating runtime
evidence (Elasticsearch, MongoDB, Grafana, Redis/BullMQ, Git) with source-code
intelligence (Axon) and reasoning over the assembled evidence deterministically.

CLI-only. Not an observability platform. **Read-only** against production systems —
it never writes to them.

## Architecture

Horus is organized in four layers:

**Source Intelligence**
- **Axon** — the default source-intelligence backend (see below).

**Runtime Evidence**
- **Elasticsearch** — logs → synthesized error-signature evidence
- **MongoDB** — application/operational state (sync state, integration state, stale/failed records)
- **Grafana** — metrics via its datasource proxy (latency spikes, error-rate change, throughput drop, queue growth)
- **Redis / BullMQ** — queue runtime state
- **Git** — change history, ownership signals

**Investigation** (deterministic)
- **Queue Stitcher** — the one source-intelligence gap Horus owns (below)
- **Timeline Engine** — orders evidence into a sequence of events
- **Correlation Engine** — connects evidence across sources into candidate incident threads

**Presentation**
- **Deterministic investigation report** — evidence, timeline, ranked + validated hypotheses, honest gap analysis, next actions
- **Optional AI narrative** — a later, optional layer on top of the deterministic report (not required to be useful)

### Axon is the default source-intelligence backend

**Axon is the default and expected source-intelligence layer used by Horus** — not an
optional advanced integration. Semantic search, hybrid search, impact analysis, code
ownership signals, change detection, and the process graph already exist in Axon, so
Horus does not duplicate them.

The **only** code-intelligence gap Horus owns is **queue-boundary stitching**: Axon's
graph terminates around `queue.add(...)` and doesn't connect a producer to the
consumer's `@Processor`. The stitcher synthesizes those producer → queue → worker edges.

> If Axon is unavailable, Horus can still collect runtime evidence, but source context,
> impact analysis, change analysis, and queue stitching become degraded.

Horus talks to Axon over **HTTP/MCP only** (no CLI shell-outs for queries). Each
repository points at an `axon host` indexing it.

## Configuration

The config model separates **code** from **runtime**:

- **Code belongs to the project** — `repositories[]`, each served by its own Axon host.
- **Runtime belongs to the environment** — `environments[].connectors` (Elasticsearch,
  MongoDB, Grafana, Redis/BullMQ).

```ts
// config/horus.config.ts
export default defineConfig({
  projects: [
    {
      name: 'leadcall-api',
      repositories: [
        {
          name: 'leadcall-api',
          path: '/repos/leadcall-api',
          axon: { hostUrl: 'http://127.0.0.1:8420' },
        },
      ],
      environments: [
        {
          name: 'production',
          readOnly: true,
          connectors: {
            elasticsearch: { indexPattern: 'leadcall-api-prod-*', serviceName: 'leadcall-api-prod' },
            mongodb: { database: 'leadcall_prod', collections: ['calls', 'tenants', 'integrations'] },
            grafana: {},
          },
        },
      ],
    },
  ],
  axon: { pinnedVersion: '1.0.1' }, // global version pin only — hosts live per repository
  database: { url: process.env.DATABASE_URL ?? 'postgresql://horus:horus@localhost:5433/horus' },
});
```

**No connector runs without an explicit project/env scope** — there are no global
connector defaults. Every command resolves a project + environment.

**Secrets are never committed.** Connector credentials are read from environment
variables at runtime (default names `ES_URL`/`ES_USERNAME`/`ES_PASSWORD`,
`GRAFANA_URL`/`GRAFANA_USER`/`GRAFANA_PASSWORD`, `MONGODB_URL`; per-connector `*Env`
fields override the names for genuinely different clusters). Keep them in a gitignored
file outside the repo (e.g. `~/.horus.env`) and `source` it before running.

## Usage

```bash
pnpm install
docker compose up -d                  # Postgres 16 on localhost:5433
pnpm build                            # build the bundled `horus` binary

# Per repository: index its Axon graph + host it
axon analyze .                        # build the per-repo index (CLI used only for this)
axon host --port 8420                 # the HTTP/MCP surface Horus talks to

source ~/.horus.env                   # runtime connector creds (gitignored)

node apps/horus/dist/index.js status  # config + per-project/env connector health
```

Help is available on every command:

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
| `horus metrics [hint] --project <p> --env <e>` | Grafana metrics evidence (latency/throughput/queue) |
| `horus explain <symbol>` · `blast-radius` · `architecture` · `what-changed` | Source-aware code intelligence (Axon) |

The flagship, end-to-end against a real environment:

```bash
horus investigate --project leadcall-api --env production "Zoho sync delays"
```
→ Axon code context + producer→queue→worker stitch + real Elasticsearch error-signature
evidence + MongoDB state evidence + timeline + correlation + ranked/validated hypotheses
+ honest gap analysis + next actions. Deterministic, no AI required.

## Layout

```
packages/
  core/         evidence model, config schema + project/env resolution, version pins
  connectors/   provider contracts + Axon (HTTP/MCP) · Elasticsearch · Grafana · MongoDB · Git
  stitcher/     queue-boundary stitcher (the one source-intelligence gap Horus owns)
  db/           Drizzle schema + migrations (plain Postgres, no pgvector)
  engine/       deterministic investigation pipeline (timeline, correlation, hypotheses, gaps)
  cli/          commander CLI
apps/horus/     composition root (bundled bin)
config/         horus.config.ts
```

## Foundation

- TypeScript monorepo (pnpm + Turborepo)
- Postgres + Drizzle — **no pgvector** (semantic search is delegated to Axon)
- **Axon** as the default source-intelligence backend, over HTTP/MCP only
- Project/environment-scoped connectors; read-only against production
