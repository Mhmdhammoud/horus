# Horus — Risk Analysis

**Date:** 2026-06-14 · **Companion to:** architecture.md

Complexity is rated S/M/L/XL (effort) and risk Low/Med/High/Critical (likelihood ×
impact). Ratings are grounded in the empirical Axon validation, **re-run on 1.0.1 via
HTTP/MCP** (round 2). The round-2 results materially lowered R1 and R8 and raised R4.

---

## 1. Top risks (ranked)

### R1 — Queue-boundary stitcher recall (High)
Round 2 (1.0.1) **removed** the broad "no semantic search" risk: Axon's hybrid search
resolves concepts/synonyms well (9/10), so log/metric mapping is delegated to Axon and
needs no Horus extractor. What remains is the **one** thing Axon can't do — connect a
producer's `.add()` to the consumer's `process()`. The **queue-boundary stitcher** must
extract queue-name literals reliably across `queue.add` / `@InjectQueue` /
`@Processor` / `WorkerHost` / `registerQueue` **and per-project wrapper adapters**.
* *Impact:* if a queue literal is missed, the async incident path stays severed and
  the investigation dead-ends at the boundary.
* *Mitigation:* AST extraction (ts-morph) over Axon `content`, not regex alone; a
  per-project wrapper adapter; **recall harness on labelled producer/worker pairs**
  (kill-criterion <60%). Scope is now narrow (queue literals only), which is why this
  dropped from Critical to High.
* *Complexity:* **M** (was L — pgvector/embedding extraction is gone).

### R2 — Multi-repo orchestration (High)
Axon is single-repo; incidents cross services (validated: `ZohoSyncFailed` lives
outside `maison-safqa`). Horus must index, register, and route across N repos.
* *Mitigation:* own repo registry in Postgres (don't trust `axon list`); embed repo
  id in every signal row; route a seed to the right repo *before* graph traversal.
* *Complexity:* **M**.

### R3 — Index staleness / drift (High)
The validated index was ~4 months old (`2026-02-24`). Stale graph → wrong file:line,
phantom symbols, missed new code.
* *Mitigation:* `horus status` surfaces staleness; `horus index --watch` wraps
  `axon serve --watch`; refuse to investigate against a stale index without `--force`.
* *Complexity:* **S**.

### R4 — Axon is a young, closed, partly-broken dependency (High → the foundation risk)
Axon is a ~3-week-old project. Observed on 1.0.1: the **CLI query surface
(`cypher`/`query`/`context`) is broken** (binds to an embeddings-only store → empty
results) — only the **HTTP/MCP interface works**; the **docs run ahead of the build**
(UPPERCASE edge labels `CALLS`/`IMPORTS` don't exist; build uses `CodeRelation` +
`rel_type`); `cypher` blocks writes *and* `CALL` (no schema introspection); `list` is
buggy. A patch release could shift any of this.
* *Impact:* a silent schema/behaviour change mis-maps results during an incident — the
  worst time to discover it.
* *Mitigation:* **pin 1.0.1**; integrate **only over HTTP/MCP** (the working surface),
  never CLI shell-outs for queries; isolate all access behind `CodeProvider`; a
  **schema contract test + version assertion** on startup that fails loudly on drift; a
  hybrid-search smoke test guarding the "semantic delegated to Axon" assumption. Treat
  the HTTP/MCP contract — not the docs — as the source of truth.
* *Complexity:* **M**.

### R5 — LLM hallucination / ungrounded root-cause (High)
A confident-but-wrong narrative during an incident is worse than no answer.
* *Mitigation:* evidence-citation requirement (model must reference `evidence.id`);
  never feed raw provider blobs; show the evidence chain alongside the narrative so a
  human can verify; rank hypotheses by deterministic signals, let the LLM *explain*
  not *invent*.
* *Complexity:* **M**.

### R6 — Connector fan-out cost & blast radius (Med)
Parallel calls to ES/Prometheus/Redis/BullMQ/Git/Axon per investigation can be slow
or hit production read load.
* *Mitigation:* `provider_cache` table with TTL; bounded concurrency; strict
  read-only credentials; time-windowed queries; circuit-breaker per provider.
* *Complexity:* **M**.

### R7 — Cost of embeddings + Opus reasoning (Med)
Indexing thousands of symbols + Opus per investigation adds up.
* *Mitigation:* Haiku for extraction/classification, Opus only for final reasoning;
  embed once and cache; prompt-cache static context; embedding only on changed
  symbols during incremental re-index.
* *Complexity:* **S**.

### R8 — Reliance on Axon's hybrid search for all semantic retrieval (Med)
v0 drops pgvector and delegates *all* concept/synonym resolution to Axon's built-in
hybrid search. If its recall is worse on an unseen repo than it was in validation
(9/10 on `leadcall-api`), seed resolution degrades and Horus has no in-house fallback.
* *Mitigation:* the HOR-4 hybrid-search smoke test catches gross regressions per repo;
  because retrieval is just an HTTP call, a Horus-side embedding fallback can be added
  later **without** schema changes if a repo proves weak — but it stays out of v0.
* *Complexity:* **S**. *(Replaces the former pgvector-ops risk, now moot.)*

### R9 — Scope creep into an observability platform (Med)
The hardest non-technical risk: Horus quietly becoming a Grafana/Kibana clone.
* *Mitigation:* hold the line — CLI only, no dashboards, no storage of time-series,
  read-through to source systems. Every feature must serve what/why/where-next.
* *Complexity:* N/A (discipline).

### R10 — No Linear access in environment (Low)
Validation worked from the brief's issue list, not full Linear bodies.
* *Mitigation:* add a Linear connector/MCP if issue detail or write-back is needed.

---

## 2. Complexity by component

| Component | Complexity | Notes |
|---|---|---|
| Monorepo + tooling (HOR-1) | S | pnpm/turbo standard |
| Postgres + Drizzle (HOR-2) | S | plain Postgres, no pgvector — simpler than before |
| Connector contracts + Axon HTTP/MCP provider (HOR-3) | M | clean interface; HTTP/MCP transport |
| Axon provider hardening + contract test (HOR-4) | M | robustness vs a young closed dep is the work |
| **Queue-boundary stitcher (STITCH)** | **M** | the one novel piece; narrowed to queue literals only |
| Investigation engine + connectors (HOR-5) | L | pipeline + 5 read connectors + correlation + ranking |
| AI reasoning | M | grounded prompting + evidence citation |

**Overall v0:** **L** (down from L–XL — pgvector/embedding extraction removed).
Critical path = Axon provider → stitcher → engine → grounded reasoning.

---

## 3. Assumptions that, if false, change the plan

1. Axon **1.0.1** schema (§1.3) is stable; the HTTP/MCP interface stays the working
   surface. *(pin + contract-test it; treat the HTTP contract, not the docs, as truth)*
2. Axon's hybrid search recall holds on unseen repos. *(smoke-test per repo; R8)*
3. Symbol `content` reliably contains the queue-name literals the stitcher parses.
   *(validated on leadcall-api)*
4. Target services emit reasonably structured logs (log codes) / queue names.
   *(validated on leadcall-api; unverified per other service)*
5. Read-only credentials to ES/Prometheus/Redis/BullMQ are obtainable.
6. Repos can be (re)indexed by Axon (`analyze`) on demand within acceptable time.

---

## 4. Kill criteria (when to revisit Option C / rethink)

* If queue-boundary crossing recall on a labelled producer/worker set stays <60% after
  AST extraction → Axon's `content` may be insufficient; consider an independent
  tree-sitter pass for queue literals.
* If Axon's hybrid-search recall is poor on a real target repo → add the deferred
  Horus-side embedding fallback (R8) — still no in-graph pgvector.
* If the 1.0.1 HTTP/MCP interface breaks or the contract test fails on a forced
  upgrade → freeze on 1.0.1; wrap or replace before moving.
* If per-investigation latency >60 s or cost is prohibitive → cut the fan-out /
  agentic mode.
