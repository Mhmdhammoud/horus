# Horus — Architecture

**Status:** Validation complete (round 2, on Axon 1.0.1). Implementation started.
**Date:** 2026-06-14
**Scope:** Horus v0 — Investigation Engine (Linear: HOR-1 … HOR-5 + queue-boundary stitcher)

> **v0 foundation (decided):** TypeScript monorepo · Postgres + Drizzle **without
> pgvector** · Redis only if/when jobs need it · **Axon 1.0.1 pinned** · Axon accessed
> **exclusively over HTTP/MCP** (`axon host`/`serve`) — **no CLI shell-outs** for
> `query`/`context`/`cypher`. Semantic search is delegated to Axon's built-in hybrid
> search, so Horus ships **no pgvector and no embedding store** in v0. The previous
> pgvector "Signal Index" plan is **superseded** by a thin **queue-boundary stitcher**.

---

## 0. What Horus is (and is not)

Horus is a **local-first, source-aware investigation engine**. Given a production
incident, it answers exactly three questions:

> **What happened? Why did it happen? Where should I look next?**

It correlates **runtime signals** (Elasticsearch logs, Prometheus metrics, Redis
state, BullMQ queues, Git history) with **source-code intelligence** (Axon's code
graph), and uses an LLM to reason over the assembled evidence.

Horus is **not** an observability platform, not a Grafana/Kibana replacement, not a
dashboard. It is a CLI-driven reasoning tool that *reads* those systems and produces
a ranked, evidence-backed hypothesis. It never writes to production systems.

---

## 1. Axon validation (HOR-4) — the load-bearing question

The single biggest architectural risk is whether **Axon can realistically be the
source-intelligence layer**. Validated empirically in two rounds against the live
install and the indexed target repos (`maison-safqa`, `leadcall-api`). Round 2 was
re-run on the **latest version, 1.0.1**, via the **HTTP/MCP interface** (the only
interface that works on 1.0.1 — see §1.5). Findings are observed, not assumed.

### 1.1 What Axon is

* A Python package (`axoniq`, **pinned to 1.0.1**) installed via `uv tool`, backed by
  an embedded **Kùzu graph database** stored **per-repo** at `<repo>/.axon/kuzu`.
  Per-repo registry pointer at `~/.axon/repos/<name>/meta.json`; host config at
  `<repo>/.axon/host.json`.
* Self-described: *"Axon — Graph-powered code intelligence engine."*
* **Per-repository** index, built with `axon analyze`. 1.0.1 generates 768-dim
  `Embedding` nodes by default, powering built-in **hybrid search** (BM25 + vector +
  fuzzy, fused via Reciprocal Rank Fusion).
* **Integration surface for Horus: HTTP/MCP only.** Run `axon host --port 8420`
  (HTTP + MCP) or `axon serve` (stdio MCP). Horus speaks to those endpoints
  (`POST /api/cypher`, `/api/search`, MCP tools). **It never shells out to the CLI**
  for `query`/`context`/`cypher` — those CLI subcommands are broken on 1.0.1 (§1.5).

### 1.2 HTTP routes (the validated integration surface)

Horus integrates with Axon exclusively over the FastAPI HTTP interface (base URL
`http://127.0.0.1:8420`, all routes under `/api`). The following routes are
**validated live against Axon 1.0.1**:

| Route | Body / params | Horus use |
|---|---|---|
| `POST /api/search` | `{"query":"…","limit":N}` | Hybrid semantic search (BM25 + vector + fuzzy RRF) — seed → candidate symbols |
| `POST /api/cypher` | `{"query":"MATCH … RETURN …"}` | Read-only graph traversal; writes rejected with HTTP 400 |
| `GET /api/impact/{node_id}?depth=N` | path param; depth 1–5 | Blast radius / change-risk propagation |
| `POST /api/diff` | `{"base":"HEAD~N","compare":"HEAD"}` | `detect_changes` primitive — git-diff → added/removed/modified nodes + edges |
| `GET /api/health` | — | Liveness check (HTTP 200 = healthy) |
| `GET /api/host` | — | Repo path, host URL, MCP URL, mode |
| `GET /api/overview` | — | `nodesByLabel` + `edgesByType` counts (graph shape telemetry) |

> **`node_id` encoding:** `node_id` may contain `:` and `/` (e.g.
> `method:src/auth/auth.service.ts:AuthService.constructor`). Build the URL with
> `encodeURI(nodeId)` so `:` and `/` are preserved and spaces encoded.

> **MCP endpoint:** a streamable HTTP MCP server is also available at `/mcp`
> (same host). Horus may use MCP tool calls as an alternative where convenient;
> the HTTP routes above are the primary integration surface.

> **CLI use:** the CLI is used **only** for index provisioning (`axon analyze`)
> and process lifecycle (`axon host`). All query traffic goes over HTTP (or `/mcp`).

### 1.3 Graph model (observed via HTTP `/api/cypher` on 1.0.1)

**Node labels** — the API returns **lowercased** label strings: `method, class,
function, interface, typealias, file, folder, community` (clusters), `process`
(execution flows), `embedding` (768-dim vectors). (`/api/overview` confirms these
via `nodesByLabel`.)

**Node properties** (shared schema per `NODE` shape):
`id, name, filePath, startLine, endLine, signature, language, className, isDead,
isEntryPoint, isExported` (camelCase in HTTP responses; Cypher uses `file_path`,
`start_line` etc. internally).

**Relationships:** a single edge label **`CodeRelation`**, typed by a `rel_type`
property. **Observed `rel_type` values on leadcall-api 1.0.1** (via `/api/overview`
`edgesByType`): `defines, calls, member_of, contains, uses_type, imports,
step_in_process, coupled_with, implements`. With `confidence (0–1)`, `role`,
`step_number` (ordered position within a flow), `strength`, `co_changes` (git
co-change count), `symbols`.

> ⚠ **Schema-vs-docs drift:** the 1.0.1 docs describe UPPERCASE per-type edge labels
> (`CALLS`, `IMPORTS`…). The installed 1.0.1 build does **not** have them —
> `MATCH ()-[:CALLS]->()` errors *"Table CALLS does not exist"*. The build still uses
> the single `CodeRelation` + `rel_type` model. **Horus pins the version and
> contract-tests the actual schema; it does not code to the docs' schema.**

Two derived node types are especially valuable to Horus:
* **`Process`** — pre-computed multi-hop **execution flows** ("which code paths relate
  to X"). *Caveat:* flows terminate at queue boundaries (§1.5 #4).
* **`Community`** — Louvain-style clusters grouping related symbols (subsystems).

### 1.4 Capability assessment (re-validated on 1.0.1 via HTTP/MCP)

| Required question | Axon answer | Verdict |
|---|---|---|
| Symbol search | `axon_query` / `/api/search` (hybrid) w/ file:line + snippet | ✅ Strong |
| **Semantic / concept** search | **Hybrid search works** — synonyms resolve ("deduplicate incoming leads"→`markDuplicateLead`, "decrypt stored credentials"→`ZohoCryptoService`) | ✅ **9/10 — Horus needs no pgvector** |
| Dependency / relationship traversal | `axon_context`, Cypher over `CodeRelation` | ✅ Strong |
| Blast radius / impact | `axon_impact -d N` (typed, confidence-weighted) | ✅ Strong |
| Code paths for a feature | `Process` flow nodes + traversal | ✅ Strong (unique strength) |
| Git-coupling / incident↔commit | `co_changes` on edges + `axon_detect_changes` | ✅ Bonus |
| Where does a **log signature** originate? | Structured log codes (e.g. `ZOH_RTM_003`) reverse-lookup to emitter via Cypher (`ZOH_RTM_003`→`ZohoRealtimeProcessor.process()` line 19) | ✅ **8.5/10** |
| Which **service owns this queue** / full producer→worker path | `Process` flow **terminates at the queue boundary**; only `defines` edges reach the Processor | ❌ **2/10 — the one irreducible gap** |
| Code paths for **ZohoSyncFailed** | Resolves once the *correct* repo is indexed; cross-repo routing is Horus's job | ⚠ multi-repo orchestration |

### 1.5 Hard limitations discovered

1. **CLI query surface is broken on 1.0.1.** `cypher`/`query`/`context` bind to an
   embeddings-only store and return 0 symbols / blank names / "not found". The
   **HTTP/MCP interface returns the full graph.** → Horus integrates via
   `axon host`/`serve`, never CLI shell-outs. (Dependency-maturity risk: see
   risk-analysis R4.)
2. **Docs run ahead of the build** (UPPERCASE edge labels don't exist in 1.0.1 —
   §1.3). → pin the version, contract-test the real schema.
3. **Single-repo scope.** The graph is keyed per repository; incidents cross
   services. Multi-repo indexing + routing is Horus-level orchestration.
4. **Queue boundaries sever the static flow graph** (validated on `leadcall-api`,
   **still true on 1.0.1**): `Process` flows stop at the producer `.add()`; the worker
   `process()` is a runtime-decoupled edge Axon never connects. Only `defines` edges
   reach the Processor class. Reconstructing a full `API → Queue → Worker → External
   API` path therefore requires Horus to **stitch across the queue boundary**. This is
   the single clearest — and now *only* — justification for a supplemental layer.
5. **Read-only, closed graph.** `cypher` rejects writes and `CALL`. Horus cannot
   enrich Axon's graph in place; it keeps its own (small) store.
6. **Staleness.** Indexes must be (re)built with `axon analyze`; `host --watch`
   keeps them live. Horus must guard against stale indexes and track its own repo
   registry (don't trust `axon list`).

### 1.6 Recommendation — **Option B (thin): Axon backbone + a queue-boundary stitcher**

Axon is a strong **code-graph backbone**, and on 1.0.1 its built-in hybrid search
**closes the semantic gap that originally justified pgvector**. Re-validation shrank
the supplemental layer to almost nothing.

> **Adopt Axon as the code-intelligence provider over HTTP/MCP, and build one thin
> supplemental pass — the queue-boundary stitcher — that synthesizes the
> producer→queue→worker edges Axon can't.** Everything else (semantic search, log
> ownership via structured codes, impact, flows, git-coupling) is delegated to Axon.

* **Superseded — pgvector "Signal Index":** Axon's hybrid search makes a Horus
  embedding store redundant in v0. Dropped.
* **Rejected — Option A (Axon as-is):** the queue boundary leaves the most common
  incident path (request → async worker → external call) disconnected.
* **Rejected — Option C (don't use Axon):** throws away a working graph, flows,
  impact analysis, hybrid search, and git-coupling for no benefit.

**Minimum supplemental layer for v0:** a queue-boundary stitcher — one pass that
parses queue-name literals (`registerQueue({name})`, `@Processor('x')`,
`@InjectQueue('x')`, `queue.add('x')`) out of Axon's `content` and synthesizes
`producer →[enqueues]→ queue →[consumed_by]→ worker` edges — plus the incident/time
correlation and AI-narrative layers. **No pgvector. No log index. No metric index.**

---

## 2. System architecture

```
                ┌─────────────────────────────────────────────┐
                │                 Horus CLI                    │
                │  investigate · explain · trace · index · ask │
                └───────────────┬─────────────────────────────┘
                                │
                ┌───────────────▼───────────────┐
                │     Investigation Engine        │  orchestration + ranking
                │  (pipeline: gather→correlate→   │
                │   hypothesize→reason→report)    │
                └───┬───────────┬──────────┬──────┘
                    │           │          │
        ┌───────────▼──┐  ┌─────▼───────┐  ┌▼───────────────┐
        │  Connectors  │  │ Queue-      │  │  AI Reasoner    │
        │  (providers) │  │ boundary    │  │  (Claude)       │
        └───┬──────────┘  │ stitcher    │  └─────────────────┘
            │             └─────┬───────┘
   ┌────────┼─────────┬─────────┼──────────┬──────────┬─────────┐
   ▼        ▼         ▼         ▼          ▼          ▼         ▼
 Axon   Elastic-   Prome-    Redis     BullMQ      Git    (stitcher reads
 (HTTP/  search    theus     (state)   (queues)  (history)  Axon content,
  MCP)   (logs)    (metrics)                                synthesizes edges)
            │
            └────────────────────────────────────────────────────┐
                          Postgres + Drizzle (no pgvector)        │
              (investigations, evidence, queue-graph, repos, cache)│
                                                                   ┘
```

> Semantic search lives **inside Axon** (1.0.1 hybrid search over HTTP/MCP), not in
> Postgres. Postgres holds only Horus's own relational state — investigations,
> evidence, the synthesized queue graph, the repo registry, and a provider cache.

### 2.1 Repository structure (HOR-1)

pnpm + Turborepo monorepo, TypeScript throughout.

```
horus/
├── package.json                 # pnpm workspace root, turbo pipeline
├── pnpm-workspace.yaml
├── turbo.json
├── docker-compose.yml           # postgres 16 (plain, no pgvector); redis added only when jobs need it
├── docs/                        # architecture.md, risk-analysis.md, implementation-plan.md
├── packages/
│   ├── core/                    # investigation engine, pipeline, evidence model, ranking
│   ├── connectors/              # provider contracts + implementations
│   │   └── src/providers/{axon,elasticsearch,prometheus,redis,bullmq,git}/
│   ├── stitcher/                # queue-boundary stitcher (the only supplemental layer in v0)
│   ├── db/                      # Drizzle schema + migrations (HOR-2) — no pgvector
│   ├── ai/                      # Claude client, prompt templates, reasoning chains
│   └── cli/                     # commander/oclif CLI, output rendering
├── apps/
│   └── horus/                   # composition root: wires CLI → engine → connectors → db
└── config/
    └── horus.config.ts          # repos, axon host url, provider creds, model ids
```

### 2.2 Connector architecture & provider contracts (HOR-3)

All external systems sit behind one `Provider` interface. The engine never talks to
a system directly — it asks providers for **Evidence**. This keeps the engine
testable and makes every source swappable/mockable.

```ts
// packages/connectors/src/contract.ts
export type ProviderKind =
  | 'code'     // Axon
  | 'logs'     // Elasticsearch
  | 'metrics'  // Prometheus
  | 'state'    // Redis
  | 'queue'    // BullMQ
  | 'history'; // Git

export interface Provider<Q = unknown> {
  readonly id: string;            // 'axon', 'elasticsearch', ...
  readonly kind: ProviderKind;
  health(): Promise<HealthStatus>;
  /** Translate an investigation query into typed Evidence. */
  collect(query: Q, ctx: InvestigationContext): Promise<Evidence[]>;
}

// Code provider adds graph-specific capabilities on top of the base contract.
export interface CodeProvider extends Provider {
  searchSymbols(text: string, limit?: number): Promise<Symbol[]>;
  context(symbolName: string): Promise<SymbolContext>;     // callers + callees
  impact(symbol: string, depth?: number): Promise<Symbol[]>;
  flowsFor(symbol: string): Promise<Flow[]>;               // Axon Process nodes
  cypher<T>(query: string): Promise<T[]>;                  // read-only escape hatch
}
```

**Axon provider** speaks **HTTP/MCP only** (no CLI shell-outs for queries — the 1.0.1
CLI query surface is broken, §1.5):
* Manages an `axon host --port <p>` process (or connects to a running one) and issues
  `POST /api/cypher`, `POST /api/search`, and MCP tool calls (`axon_context`,
  `axon_impact`, `axon_detect_changes`).
* `cypher()` is the power tool: relationship traversal, flow lookup, dead-code,
  co-change coupling — all expressible as read-only `MATCH/RETURN` over HTTP.
* The **only** CLI use is index provisioning (`axon analyze`) and process lifecycle.
* Pins Axon **1.0.1** and runs a **schema contract test** (§1.3) on startup so a
  drifted build fails loudly rather than silently mis-mapping.
* Maintains Horus's **own repo registry** (don't trust `axon list`); ensures each
  configured repo is indexed and not stale before an investigation runs.

A `ConnectorFactory` instantiates providers from `horus.config.ts`, exposes
`getProvider(kind)` / `allProviders()`, and runs `health()` on startup.

### 2.3 The queue-boundary stitcher (the only supplemental layer in v0)

Round-2 validation collapsed the old pgvector "Signal Index" into a single targeted
pass. Axon 1.0.1 already does semantic search (hybrid), log ownership (structured
codes via Cypher), and impact/flows. The **one** thing it cannot do is connect a
producer that enqueues a job to the worker that consumes it — its `Process` flows
terminate at the queue boundary. The stitcher fixes exactly that, and nothing more.

It runs as part of the **build step** (`horus index`) after `axon analyze`:

1. Pull `Method/Function/Class` nodes (+`content`, `file_path`, `start_line`) via
   `POST /api/cypher`.
2. Parse **queue-name literals** out of `content` (regex + ts-morph for precision):
   * **Producers** — `queue.add('name', …)`, `@InjectQueue('name')`.
   * **Workers** — `@Processor('name')`, `WorkerHost` / `new Worker('name')`.
   * **Registration** — `BullModule.registerQueue({ name: 'name' })`,
     and project wrapper adapters (e.g. a `queue-manager.ts`).
3. Build a **queue graph** in Postgres: for each queue name, synthesize
   `producer →[enqueues]→ queue →[consumed_by]→ worker` edges, each carrying the
   `axon_symbol_id` + `file_path:line` of both ends so the engine can hop straight
   back into Axon for `context`/`impact`/`flowsFor`.

Query path: an incident implicating an async path → resolve the seed symbol via Axon
hybrid search → if the flow dead-ends at a `.add()`, the engine consults the stitched
queue graph to cross the boundary to the worker (and vice-versa), then resumes Axon
traversal on the far side. No embeddings, no vector store — pure literal extraction
plus Axon's own graph.

### 2.4 Investigation pipeline (HOR-5)

```
investigate(incident) →
  1. PARSE      normalize the incident input (log line, alert, metric, queue name,
                free text) into typed seeds.
  2. RESOLVE    Axon hybrid search maps each seed → candidate symbols / files /
                flows; the stitched queue graph crosses any queue boundary the flow
                dead-ends on.
  3. GATHER     fan out to all relevant providers in parallel:
                  logs  → surrounding Elasticsearch context (time window, trace id)
                  metrics → Prometheus series around the incident timestamp
                  state → Redis keys implicated by the code paths
                  queue → BullMQ job/queue state (failed/stalled counts)
                  history → Git blame + recent commits touching candidate files
                  code  → Axon context/impact/flows for candidates
  4. CORRELATE  align all evidence on a timeline; score relevance; cluster by
                Axon Community (subsystem).
  5. HYPOTHESIZE rank candidate root causes (recency of change + co_changes +
                error correlation + blast radius).
  6. REASON     Claude consumes the structured Evidence bundle and produces:
                what happened · why · where to look next, each citing evidence ids.
  7. REPORT     render investigation + evidence chain to terminal / JSON / markdown.
```

Each stage is pure-in/pure-out over the Evidence model, so stages are independently
testable and the whole pipeline is replayable from a persisted bundle.

### 2.5 Evidence model

Evidence is the universal currency between providers, the engine, and the LLM.
Everything the AI sees is a typed, attributable `Evidence` — no raw provider blobs
reach the model, which keeps reasoning grounded and auditable.

```ts
interface Evidence {
  id: string;                  // stable, citable: 'ev_log_01H...'
  source: ProviderKind;        // who produced it
  kind: 'log' | 'metric' | 'symbol' | 'flow' | 'commit' | 'queue-state' | 'redis-key' | 'impact';
  title: string;               // human summary
  timestamp?: string;          // for timeline alignment
  relevance: number;           // 0–1, engine-assigned
  payload: unknown;            // typed per kind
  links: {                     // graph back-references
    file?: string; line?: number; symbolId?: string; commit?: string; traceId?: string;
  };
  provenance: { query: string; collectedAt: string }; // reproducibility
}
```

An `Investigation` aggregates: seeds, the ordered Evidence list, the hypothesis
ranking, and the final AI narrative — all persisted (§2.6) for replay and audit.

### 2.6 Database schema (HOR-2) — Postgres + Drizzle (no pgvector)

```
investigations      id, title, incident_input(jsonb), status, created_at,
                    summary(text), narrative(jsonb)            -- AI output
evidence            id, investigation_id→, source, kind, title, timestamp,
                    relevance(real), payload(jsonb), links(jsonb), provenance(jsonb)
hypotheses          id, investigation_id→, rank, statement, score(real),
                    supporting_evidence(uuid[])
queue_edges         id, repo, queue_name, role(producer|consumer),
                    symbol_name, axon_symbol_id, file_path, line   -- stitcher output
repos               id, path, name, last_indexed_at, axon_status(jsonb), stale(bool)
provider_cache      key, source, response(jsonb), expires_at      -- dedupe expensive calls
```

Plain Drizzle migrations — **no pgvector extension, no embedding columns, no ANN
index** in v0 (semantic search is delegated to Axon's hybrid search over HTTP/MCP).
`queue_edges` is the materialized queue graph; the engine joins producer rows to
consumer rows on `(repo, queue_name)` to cross the boundary. Postgres (over SQLite)
is chosen for concurrent access, jsonb, and a clean upgrade path — **not** for vectors.

### 2.7 AI integration strategy

* **Model:** Claude Opus 4.8 (`claude-opus-4-8`) for the final reasoning step;
  Haiku 4.5 (`claude-haiku-4-5`) for cheap intermediate classification/extraction.
  **No embedding model in v0** — semantic retrieval is Axon's hybrid search.
* **Grounded reasoning only.** The model receives the structured `Evidence[]`
  bundle and must cite `evidence.id`s in its conclusions. No ungrounded claims.
* **Tool-use option:** expose Axon (`axon_context`, `axon_impact`, `axon_cypher`,
  `axon_query`) and the stitched queue graph as tools so the model can *pull* more
  evidence mid-investigation ("agentic" mode), with a hard call budget. v0 ships the
  simpler pre-gathered-bundle approach; agentic mode is a v1.1 flag.
* **Prompt-cache** the static system prompt + repo/subsystem context across a
  session to cut cost.
* **Determinism aids:** record the exact evidence bundle + prompt with each
  investigation so a narrative can be regenerated/audited.

### 2.8 CLI command structure

```
horus index [--repo <path>] [--watch]      # axon analyze + run the queue-boundary stitcher
horus investigate "<incident>"             # full pipeline; <incident> = log line / alert / text
   --since 1h --service <name> --json
horus explain <symbol|flow>                # Axon context+impact+flows, human-readable
horus trace <log-signature>                # signal → origin symbol → code paths
horus ask "<question>"                      # natural-language Q over the graph + signals
horus status                                # provider health, repo freshness
horus replay <investigation-id>            # re-render / re-reason a saved investigation
```

`investigate` is the headline command; `trace` and `explain` are the focused
primitives it composes.

---

## 3. How the validation questions are answered (end to end)

| Question | Resolution path |
|---|---|
| Where does a log signature originate? | Structured log-code reverse-lookup via Axon Cypher → emitter symbol → `context` → file:line + callers |
| Which service owns this queue? | **Stitched queue graph** (`queue_edges`) → producer/consumer symbols + repo (the one gap Axon can't close) |
| Which files relate to this metric? | Axon hybrid search on the metric name/concept → instrumentation sites → `impact` for spread |
| Which code paths relate to ZohoSyncFailed? | Axon hybrid (semantic) search resolves the *correct* repo → `flowsFor` (`Process` nodes), stitcher crosses any queue hop |
| What/why/where-next | Full pipeline §2.4 → grounded Claude narrative |

---

## 4. Decisions (resolved) & open items

**Resolved (v0 foundation):**
1. **Axon transport — HTTP/MCP only.** The 1.0.1 CLI query surface is broken; HTTP/MCP
   works. No CLI shell-outs for `query`/`context`/`cypher`. (CLI used only for
   `analyze` + process lifecycle.)
2. **Axon version — pinned 1.0.1**, guarded by a schema contract test.
3. **Semantic layer — delegated to Axon.** No pgvector, no embedding store in v0.
4. **Supplemental scope — queue-boundary stitcher only.** Log/metric indices dropped.
5. **Multi-repo registry — Horus config file** (don't trust `axon list`).

**Open items:**
* **Linear access:** no Linear MCP is configured here; this doc was built from the
  task-brief issue list (HOR-1…HOR-5) plus empirical validation. Add a Linear
  connector if full issue bodies / write-back are needed.
* **Redis:** introduced only when/if the engine needs background jobs; not in the v0
  critical path.
```
