# Horus

Local-first, source-aware production-incident investigation engine. Given an incident,
it answers **what happened, why, and where to look next** — by correlating runtime
signals (Elasticsearch, Prometheus, Redis, BullMQ, Git) with source-code intelligence
(Axon) and reasoning over the assembled evidence with Claude.

CLI-only. Not an observability platform. It never writes to production systems.

See [`docs/architecture.md`](docs/architecture.md), [`docs/risk-analysis.md`](docs/risk-analysis.md),
[`docs/implementation-plan.md`](docs/implementation-plan.md), and the Axon validation
in [`docs/axon-round-2.md`](docs/axon-round-2.md).

## v0 foundation

- TypeScript monorepo (pnpm + Turborepo)
- Postgres + Drizzle — **no pgvector** (semantic search is delegated to Axon)
- Redis only if/when the engine needs background jobs
- **Axon 1.0.1 pinned**, accessed over **HTTP/MCP only** (no CLI shell-outs for
  queries — the 1.0.1 CLI query surface is broken)
- The only supplemental layer is a **queue-boundary stitcher** (the one thing Axon
  can't do: connect a producer's `queue.add` to the consumer's `@Processor`)

## Layout

```
packages/
  core/        evidence model, config schema + loader, version pins
  connectors/  provider contracts + Axon HTTP/MCP provider   (HOR-3/4)
  stitcher/    queue-boundary stitcher                        (STITCH)
  db/          Drizzle schema + migrations, no pgvector       (HOR-2)
  ai/          Claude reasoner                                (HOR-5)
  cli/         commander CLI
apps/horus/    composition root (bundled bin)
config/        horus.config.ts
```

## Develop

```bash
pnpm install
docker compose up -d            # Postgres 16 on localhost:5433
pnpm horus status               # config + provider health
pnpm typecheck && pnpm test && pnpm build
```

To point Horus at Axon, start a host inside (or pointed at) an indexed repo and set
`axon.hostUrl` in `config/horus.config.ts`:

```bash
axon analyze .                  # build the per-repo index (CLI is used only for this)
axon host --port 8420           # HTTP + MCP surface Horus talks to
```

## Build order

`HOR-1` monorepo → `HOR-2` Postgres+Drizzle → `HOR-3` connector contracts + Axon
provider → `HOR-4` provider hardening + schema contract test → `STITCH`
queue-boundary stitcher → `HOR-5` investigation engine.
