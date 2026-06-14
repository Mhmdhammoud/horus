# Horus — Implementation Plan

**Date:** 2026-06-14 · **Companion to:** architecture.md, risk-analysis.md
**Status:** docs accepted; implementation started.

**v0 foundation (decided):** TypeScript monorepo · Postgres + Drizzle **without
pgvector** · Redis only if/when jobs need it · **Axon 1.0.1 pinned** · Axon accessed
**over HTTP/MCP only** (no CLI shell-outs for query/context/cypher) · **no pgvector**.
The previous pgvector "Signal Index" is **superseded** by a queue-boundary stitcher.

---

## Phase 0 — Validation (DONE)
Empirical Axon validation complete, **re-run on 1.0.1 via HTTP/MCP** (architecture.md
§1, docs/axon-round-2.md). **Decision: Option B (thin)** — Axon backbone + a
queue-boundary stitcher. pgvector dropped (Axon hybrid search covers semantic).

---

## Build order

```
HOR-1 ─▶ HOR-2 ─▶ HOR-3 ─▶ HOR-4 ─▶ STITCH ─▶ HOR-5
```

### HOR-1 — Monorepo foundation
**Goal:** a wired-but-empty monorepo that boots.
1. pnpm + Turborepo workspace; TS strict; eslint/prettier; vitest.
2. Package skeletons: `core`, `connectors`, `stitcher`, `db`, `ai`, `cli`,
   `apps/horus`. (No `signal-index` package.)
3. `docker-compose.yml`: **Postgres 16 (plain image, no pgvector)**. Redis omitted
   for now — added under HOR-5 only if background jobs are introduced.
4. `horus.config.ts` loader (repos, axon host url, provider creds, model ids).
5. `horus status` skeleton (prints config + reachability stubs).
**Exit:** `pnpm build` + `pnpm horus status` run green on an empty shell.

### HOR-2 — Postgres + Drizzle (no pgvector)
**Goal:** relational state, no vectors.
1. Drizzle schema from architecture.md §2.6: `investigations`, `evidence`,
   `hypotheses`, `queue_edges`, `repos`, `provider_cache`.
2. **No pgvector extension, no embedding columns, no ANN index.**
3. First migration; migrate-on-boot helper; connection pool.
4. `horus status` now verifies DB reachable + migrations applied.
**Exit:** `pnpm horus status` reports DB green; migrations idempotent.

### HOR-3 — Connector contracts + Axon HTTP/MCP provider
**Goal:** the code-intelligence path works through the abstraction.
1. `Provider` / `CodeProvider` contracts + `ConnectorFactory` (architecture.md §2.2).
2. **Axon provider — HTTP/MCP transport only:** manage/connect to `axon host`, call
   `POST /api/cypher`, `POST /api/search`, MCP `axon_context`/`axon_impact`/
   `axon_detect_changes`. **No CLI shell-outs for queries** (CLI only wraps
   `axon analyze` + lifecycle). Map outputs → `Symbol`/`SymbolContext`/`Flow`/`Evidence`.
3. Repo registry (Postgres `repos`) + staleness check (don't trust `axon list`).
4. Health + actionable errors (host down / index missing / stale).
**Exit:** `horus explain <Symbol>` returns callers/callees/impact via the provider
abstraction, sourced over HTTP/MCP.

### HOR-4 — Axon provider hardening + schema contract test
**Goal:** lock the dependency against drift.
1. **Schema contract test** pinning the validated 1.0.1 graph (architecture.md §1.3):
   node labels, `CodeRelation` + `rel_type` model, key properties. Fails loudly if a
   build drifts (e.g. docs' UPPERCASE edge labels appear, or props change).
2. Version assertion: refuse to run against an Axon != pinned 1.0.1 without `--force`.
3. Hybrid-search smoke test: a known synonym query resolves to its expected symbol
   (guards the "semantic delegated to Axon" assumption).
4. Resilience: host restart/reconnect, timeouts, bounded retries.
**Exit:** contract + smoke tests green; provider survives a host bounce.

### STITCH — Queue-boundary stitcher (new ticket) ⭐ the one supplemental layer
**Goal:** synthesize the producer→queue→worker edges Axon can't.
1. Pull `Method/Function/Class` (+`content`) via `POST /api/cypher`.
2. Extract queue-name literals (regex + ts-morph): `queue.add('x')`,
   `@InjectQueue('x')`, `@Processor('x')`, `WorkerHost`/`new Worker('x')`,
   `BullModule.registerQueue({name})`, plus per-project wrapper adapters.
3. Materialize `queue_edges` (producer/consumer rows w/ `axon_symbol_id` + file:line).
4. Engine helper: cross a queue boundary by joining producers↔consumers on
   `(repo, queue_name)`, then resume Axon traversal on the far side.
5. **Recall harness:** labelled producer/worker pairs on `leadcall-api`; measure
   crossing accuracy (kill-criterion <60%).
6. `horus index` runs `axon analyze` then the stitcher.
**Exit:** a full `API → Queue → Worker → External API` path reconstructs end-to-end
on `leadcall-api`.

### HOR-5 — Investigation engine + AI
**Goal:** the full pipeline and grounded narrative.
1. Runtime connectors (read-only): ES (logs) → Prometheus (metrics) → Git
   (blame/recent, reuse Axon `co_changes` + `axon_detect_changes`) → BullMQ (job
   state) → Redis (implicated keys). Each → `Evidence[]`, behind `provider_cache` TTL
   + bounded concurrency. **Redis/BullMQ introduced here**, with a job queue only if
   the engine actually needs async work.
2. Pipeline stages parse→resolve→gather→correlate→hypothesize→reason→report
   (architecture.md §2.4), pure-in/pure-out over Evidence.
3. Resolve uses Axon hybrid search + the stitched queue graph for boundary crossings.
4. Timeline correlation + relevance scoring + Community clustering; hypothesis
   ranking (recency + `co_changes` + error-correlation + blast radius).
5. AI reasoner (Opus 4.8): structured Evidence bundle → what/why/where-next, **must
   cite evidence ids**; Haiku for extraction. Prompt-cache static context.
6. Persist `investigations`/`evidence`/`hypotheses`; `horus replay <id>`.
7. Renderers: terminal, `--json`, markdown.
**Exit:** `horus investigate "<incident>"` produces a ranked, evidence-cited report.

---

## Sequencing & dependencies
```
HOR-1 ─▶ HOR-2 ─▶ HOR-3 ─▶ HOR-4 ─▶ STITCH ─▶ HOR-5
```
Strictly linear in v0 (each builds on the prior). Runtime connectors inside HOR-5 are
internally parallelizable once the engine skeleton exists.

## Definition of done (v0)
* The five validation questions answerable end-to-end via CLI.
* `investigate` yields evidence-cited what/why/where-next.
* Queue-boundary crossing recall ≥ target on the labelled set.
* Axon **schema contract + version pin** green; stale-index guard active.
* Integration is HTTP/MCP only — zero CLI shell-outs for queries.
* No writes to any production system; no dashboards (scope discipline held).
* No pgvector, no embedding store (semantic delegated to Axon).

## Explicitly out of scope (v0)
Web UI/dashboards · time-series storage · alerting · write-back to prod · pgvector /
embedding store · log & metric supplemental indices · non-TS repo support beyond what
Axon already indexes · agentic tool-use reasoning (v1.1).

## Deferred to v1.1
Agentic (tool-use) reasoning with call budget · `axon host --watch` live re-index
wiring · circuit breakers · Linear connector · multi-repo investigation routing polish.
