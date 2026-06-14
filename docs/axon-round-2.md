# Axon Validation — Round 2 (Upper-Bound Probe)

**Date:** 2026-06-14
**Goal:** find the *ceiling* of Axon's capability before Horus builds any supplemental
indexing. Use Axon as the source of truth; minimize manual source inspection.
**Method:** all findings below come from `axon query / context / impact / cypher`
against the live `leadcall-api` index (990 symbols, 4473 relations), re-indexed in 12s.

> ⚠️ **READ FIRST — version caveat.** All tests ran on the **installed `axoniq
> v0.2.2`**. The latest release is **v1.0.1**, and **v0.2.3 added "embeddings, noise
> filtering, confidence tags, depth grouping, process search, multi-repo registry."**
> We are **one version before semantic/vector search shipped.** Several scores below
> are pessimistic for this reason and **must be re-run after upgrading** (see §6).

---

## 1. Findings by test

### Test 7 first — Cypher deep dive (it reframes everything)

The graph is **richer than Round 1 documented.** Full schema:

**Node labels (9):** `Method, File, Class, Function, Interface, Folder, TypeAlias,
Community, Process`.

**Relationship types (9)** — Round 1 only saw `calls`/`extends`:

| rel_type | count | carries | meaning |
|---|---|---|---|
| `calls` | 1031 | confidence | call graph |
| `defines` | 990 | — | file → symbol |
| `coupled_with` | 919 | **strength, co_changes** | **git co-change coupling** |
| `member_of` | 616 | — | symbol → Community (subsystem) |
| `contains` | 288 | — | folder/file nesting |
| `uses_type` | 282 | **role = return\|param\|variable** | **type-dependency graph** |
| `imports` | 254 | — | module imports |
| `step_in_process` | 89 | **step_number** | **ordered flow membership** |
| `implements` | 4 | — | interface impl |

**Unexploited capabilities discovered:**
* **`Community` = auto-labelled subsystems.** 25 communities with *semantic* names:
  `Zoho+crm, Zoho+call-log, Device+realtime, Auth+company, Entitlements+subscription,
  Notification+device…`. `member_of` edges give subsystem ownership for any symbol
  (`ZohoRealtimeProcessor → Zoho+mock`). Membership is **coarse/noisy** (the
  `Zoho+mock` cluster also contains AuthService, guards, AppConfig) — useful for
  "roughly which subsystem", not precise ownership.
* **`coupled_with` (git):** `strength` (0–1) + `co_changes` count per pair — a
  change-risk / "what moves together" signal, free.
* **`uses_type` with `role`:** return/param/variable type dependencies — a real
  type graph Horus never used.
* **`step_in_process` with `step_number`:** ordered flow steps as queryable edges.
* Every symbol node carries full **`content`** (source text) + `is_dead`,
  `is_entry_point`, `is_exported`, `signature`, `class_name`.
* **Kùzu function gaps:** `CALL show_tables()` is blocked and `substring()` returns
  empty in this build — schema introspection must go via `MATCH … label(n)`.

---

### Test 1 — Symbol Intelligence — **score 6/10**

| symbol | result |
|---|---|
| `refreshAccessTokenSingleFlight` | ✅ signature + caller (`ensureAccessToken`) + **5 cross-file callees** (rep.service, zoho-crypto, zoho-oauth). Excellent. |
| `ZohoRealtimeProcessor` | ⚠️ **only 1 callee** (`forContext`). **Missed `extends WorkerHost` and the DI call `zohoPusher.processPending()`.** |
| `createLead` | ⚠️ resolved to the **mock** provider (name collision — `context` doesn't disambiguate by file), but correctly flagged **DEAD CODE**. |

* Caller/callee discovery: **strong for direct calls, weak for NestJS DI &
  decorator wiring** (injected services, `@Processor`, module providers under-captured).
* Impact: **conservative/shallow** — `refreshAccessTokenSingleFlight -d3` returned
  only 2 symbols; `ZohoRealtimeProcessor` returned 0 (instantiated via DI, no direct
  callers in graph).
* Flow quality: decent within the call graph; dead-code flagging is a genuine plus.

### Test 2 — Fuzzy Concept Search — **score 7/10** (was under-rated in Round 1)

`axon query` is BM25 over name+content and does **real multi-token concept
matching** — no exact identifiers needed:

| concept | top hit(s) | verdict |
|---|---|---|
| zoho refresh | ZohoOAuthService, `refreshToken` | ✅ |
| oauth token | ZohoOAuthService, ZohoOAuthController | ✅ |
| webhook verification | StripeWebhookController, `handleWebhook` | ✅ |
| lead assignment | CrmService, ZohoPusherService | ✅ |
| call attribution | `buildCallPayload`, `createCall` | ✅ |
| campaign attribution | `listCampaigns` | ✅ |
| crm sync | ZohoCronService (✅) but EmailService on top (noise) | ⚠️ |
| failed sync | EmailService / event services — mixed | ⚠️ |

Good **subsystem-level recall**; ranking has lexical noise (sync-named email
helpers surface). Pure-synonym queries with zero lexical overlap would still miss —
**this is exactly what v0.2.3 embeddings should fix.**

### Test 3 — Queue Discovery — **score 5/10**

Reconstructable as a **node set**, not a topology:
* **Consumers:** `MATCH (n:Class) WHERE content CONTAINS 'WorkerHost'` → clean 2:
  `ZohoBatchProcessor, ZohoRealtimeProcessor`. ✅
* **Registration:** searching `registerQueue/BullModule` → the owning modules
  (`zoho.module`, `call-log.module`, `app.module`) + injecting services. ✅
* **Producers:** `content CONTAINS '.add('` → candidates (`handlePendingSyncs`,
  `retryFailed`, `backfill`, `syncLogs`) **mixed with false positives** (`Set.add`,
  array adds). ⚠️ Noisy — Axon has no first-class "queue" concept.

### Test 4 — Log Ownership — **score 8.5/10** (best result; convention-dependent)

The codebase uses **structured log event codes** (`LogEvents.ZOH_RTM_001…`) defined
in a canonical catalog `src/common/logging/log-events.ts`, routed through
`LeadCallLogger`. This makes log→code a **pure Cypher join**:

* **Reverse lookup (the killer query):** `MATCH (n) WHERE n.content CONTAINS
  'ZOH_RTM_003'` → exact emitter `ZohoRealtimeProcessor.process()` @ line 19 + the
  catalog definition + file. **Flawless.**
* **Full ownership map:** `content CONTAINS 'LogEvents.'` → emitter method → owning
  class → file, across the whole repo in one query.
* Severity slicing works: `logger.error` (16 sites), `logger.warn` (17 sites).
* ⚠️ Depends on the structured-logging convention. A repo logging raw template
  strings would need template extraction (still doable from `content`, just messier).

### Test 5 — Metrics Discovery — **score N/A (capability ~5/10)**

`leadcall-api` has **no real metrics** — only a `MockCounters` test interface;
`prom-client`/`Counter`/`Gauge`/`observe`/`inc` matches were test scaffolding.
Axon correctly reflects the absence (a true negative). The **same content-search
mechanism that nailed logs would locate metric definitions** (`new Counter({name})`)
*if they existed* — metric names are string literals in `content`. Untestable here;
**this is an observability gap in the code, not an Axon gap.**

### Test 6 — Cross-Boundary Flow Reconstruction — **score 2/10 (the hard wall)**

**The graph truly terminates at the queue boundary.** Evidence:
* The only edges reaching the worker classes are structural `defines`
  (file → class). **No `calls`, no `coupled_with`, no `step_in_process` edge links
  any producer to any worker.**
* `zoho.module.ts` content reveals the wiring is name-based:
  ```
  BullModule.registerQueue({ name: 'zoho-sync-realtime' })
  BullModule.registerQueue({ name: 'zoho-sync-batch' })
  ZohoRealtimeProcessor, ZohoBatchProcessor
  ```
  The **queue-name literal is the join key** — it *is* present in `content`
  (producer's `add('zoho-sync-realtime')`, the `registerQueue` name, the worker's
  `@Processor('zoho-sync-realtime')`), but Axon **does not extract it as an entity
  or edge.** So the bridge is *recoverable from content* but *absent from the graph*.

**This is the single irreducible gap.** `API → producer.add() → [queue] → worker →
external API` cannot be traversed in Axon; it must be stitched on the queue name.

---

## 2. Scorecard

| Test | Capability | Score (v0.2.2) | Likely w/ v1.0.1 |
|---|---|---|---|
| 1 | Symbol intelligence (caller/callee/impact) | 6 | 7 (confidence tags, depth grouping) |
| 2 | Fuzzy concept search | 7 | 8–9 (**embeddings**) |
| 3 | Queue node discovery | 5 | 5 (no queue concept added) |
| 4 | Log ownership (structured codes) | 8.5 | 8.5 |
| 5 | Metrics discovery | N/A (~5) | ~5 |
| 6 | Cross-boundary flow bridge | 2 | 2 (architectural, not version) |
| 7 | Cypher / graph richness | 8 | 8+ |

---

## 3. What Horus can COMPLETELY delegate to Axon

1. **Symbol & concept search** — `query` (esp. once embeddings are on).
2. **Caller/callee & type dependencies** — `context`, `uses_type`.
3. **Impact / blast radius** — `impact` (conservative, but real).
4. **Dead-code detection** — `is_dead` / `dead-code`.
5. **Log → code ownership** — Cypher reverse-lookup on structured codes + the
   `LogEvents` catalog. *No Horus index needed for log origin* in this codebase.
6. **Subsystem clustering** — `Community` + `member_of` (coarse ownership).
7. **Git co-change coupling** — `coupled_with` (strength, co_changes).
8. **Intra-service flows** — `Process` + `step_in_process` (up to the queue wall).

## 4. What Horus must STILL build

1. **Queue entity + topology edges** (the one true gap). Extract queue-name literals
   from `content` (`registerQueue({name})`, `@Processor('x')`, `@InjectQueue('x')`,
   `queue.add('x')`) and synthesize `producer —[enqueues:x]→ queue —[consumed_by]→
   worker` edges. ~1 pass over Axon content.
2. **Cross-boundary flow stitching** — compose intra-service `Process` flows across
   the queue edges from (1) to get end-to-end `API→…→external` paths.
3. **Runtime-signal join** — map *live* signals to code:
   * Logs: if structured codes are in the ES document → **trivial key-join, no
     embedding.** If only rendered messages → template match.
   * Metrics: extract metric-name literals (when metrics exist) → Prometheus series.
   * Queues: BullMQ job/queue name → the queue entity from (1).
4. **Incident/time correlation & ranking & AI narrative** — never Axon's job.

## 5. Minimum supplemental layer if Horus shipped tomorrow

Drastically smaller than the original "Signal Index" plan:

> **A single "Boundary & Signal Map" build step that:**
> **(a)** parses queue-name literals from Axon `content` → builds the
> producer↔queue↔worker edges, and
> **(b)** exposes structured log codes / metric names already in `content` as a
> lookup table keyed by the literal.
>
> Everything else — symbol search, log ownership, impact, coupling, subsystems,
> intra-service flows — is **delegated to Axon as-is.**

What this means concretely:
* **The pgvector semantic layer may not be needed at all** if (i) v0.2.3 embeddings
  cover fuzzy search and (ii) logs/metrics carry stable literal keys (they do here).
  Defer pgvector until proven necessary.
* The "Signal Index" collapses from *"extract + embed every log/metric/queue across
  repos"* to *"extract queue-name edges + a literal lookup table."* Possibly a few
  hundred lines, not a subsystem.

## 6. Updated recommendation

**Still Option B — but a much thinner B, and gated on a version upgrade.**

1. **Upgrade Axon 0.2.2 → 1.0.1 and re-run Tests 2, 3, 6** before committing scope.
   v0.2.3's **embeddings + multi-repo registry** land *after* our installed build and
   directly attack our two biggest assumed gaps (semantic search, single-repo). It is
   not safe to design Horus against a build that predates them. *(Upgrade not
   performed — it would replace the installed tool and may require re-indexing the
   ~11 GB store; needs your go-ahead.)*
2. **Treat the queue boundary as the only guaranteed-permanent gap** (Test 6 is
   architectural, not a version artifact). Build the Boundary Map (§5) regardless.
3. **Delegate log ownership to Axon Cypher** given the structured-logging convention;
   do not build a log index.
4. **Hold pgvector** until post-upgrade testing proves Axon's embeddings insufficient.

**Net:** the upper bound of Axon is higher than Round 1 assumed. The defensible
minimum Horus build is: *queue-boundary edges + a literal signal lookup + correlation/
AI* — pending an upgrade that may shrink it further.

---

## 7. v1.0.1 UPGRADE — re-test results (added 2026-06-14, post-upgrade)

Upgraded `axoniq` **0.2.2 → 1.0.1** (`uv tool upgrade axoniq`) and re-indexed
`leadcall-api`. Two findings, one good and one blocking.

### ✅ Finding A — the semantic gap is CLOSED in core Axon
* `axon analyze` now generates **vector embeddings by default** (downloads a HF
  model; `--no-embeddings` to skip). Re-index produced **1216 `Embedding` nodes**,
  each a first-class node with `node_id` (`file:…`, `method:…`) + `vec` (768-dim).
* So **v0.2.3+ ships a built-in semantic/vector layer.** The single biggest reason
  Horus was going to build pgvector **no longer exists in principle** — Axon has it.
* v1.0.x also adds `host` (HTTP MCP, multi-session), `ui` (web codebase viz), and
  **noise filtering** (relationships 4473→3470, coupled-pairs 919→25, flows 13→9 on
  the same repo — the graph got more conservative/cleaner).
* New: **multi-repo registry works** — `axon list` now correctly shows registered
  repos (it was buggy/empty on 0.2.2). Data moved to per-repo stores under
  `~/.axon/repos/<repo>/`.

### ❌ Finding B — the Cypher/query read-path REGRESSED in this environment (blocker)
After the upgrade, the interfaces Horus depends on return degraded/empty data:
* `axon cypher "MATCH (n) WHERE n.name IS NOT NULL RETURN count(*)"` → **0**.
  `MATCH (n) RETURN label(n)` → **only `Embedding` (1216)**; `MATCH (n:Class)` → 0,
  `MATCH (n:Method)` → 0.
* `axon query "…"` → returns rows but with **blank names and paths**.
* `axon context "ZohoRealtimeProcessor"` → **"Symbol not found"**.
* Yet `axon status`/`list` correctly report 990 symbols / 3470 relations.

**Root cause (high confidence):** the multi-repo migration. The legacy monolithic
`~/.axon/kuzu` (11 GB, dated Mar 7, pre-registry) is now **orphaned**, while v1.0.1
writes code symbols to `~/.axon/repos/leadcall-api/`. `status/list/analyze` use the
new registry; **`cypher/query/context` are still bound to the stale global DB** (which
only received the embedding nodes), so they see embeddings but no symbols. It is a
storage-binding collision from upgrading in place over an old store — not (necessarily)
a permanent product defect.

### Resolution — validated on 1.0.1 via the HTTP/MCP interface (not the CLI)

The "blocker" was a **CLI bug, not a data problem.** Pinned `axoniq==1.0.1`, clean-
reindexed `leadcall-api`, started `axon host --port 8420`, and queried the documented
**HTTP/MCP endpoints** (`/api/cypher`, `/api/search`, `/mcp`). The full graph is intact
and queryable there:

```
POST /api/cypher  MATCH (n) RETURN label(n), count(*)
→ Method 511, File 226, Class 199, Function 139, Interface 106,
  Folder 68, Community 39, TypeAlias 35, Process 9, Embedding 1216
```

**Conclusion: `axon cypher`/`query`/`context` (the CLI) are broken in 1.0.1** (they
bind to an embeddings-only store and return 0 symbols / blank names / "not found").
**The `axon host` / `axon serve` HTTP+MCP interface works correctly** — and it is the
*documented primary integration path*. **Horus must integrate via MCP/HTTP, never CLI
shell-outs.** This flips the architecture.md transport decision (MCP is now v0, not v1.1).

### Re-run results on 1.0.1 (over HTTP)

| Test | Result on 1.0.1 | New score |
|---|---|---|
| **Schema** | Installed build **still uses single `CodeRelation` edge + `rel_type`** (defines 990, calls 868, member_of 706, contains 288, uses_type 282, imports 254, step_in_process 53, coupled_with 25, implements 4). The docs' UPPERCASE per-type labels (`CALLS`…) are **ahead of the build** — `MATCH ()-[:CALLS]->()` errors "Table CALLS does not exist". 0.2.2 schema knowledge holds. | — |
| **2 — Semantic search** | **Hybrid BM25+vector+fuzzy works.** Pure-synonym queries resolve: "deduplicate incoming leads"→`markDuplicateLead`; "send a notification when disconnected"→`notifyDisconnect`/`sendZohoDisconnected`; "decrypt stored credentials"→`ZohoCryptoService`/`decryptToken`; "verify a webhook signature"→`StripeWebhookController.handleWebhook`. 384-dim `bge-small`, 1216 embeddings. | **9/10** (was 7) |
| **4 — Log ownership** | Reverse lookup still flawless: `ZOH_RTM_003`→`ZohoRealtimeProcessor.process()` @ line 19. | **8.5/10** |
| **3 — Queue workers** | 2 via `WorkerHost`, clean. | 5/10 |
| **6 — Queue boundary** | **STILL TERMINATES.** Only `defines` edges reach the Processors (`zoho-*.processor.ts → ZohoBatchProcessor/ZohoRealtimeProcessor`); no producer→worker edge exists. Confirmed on latest — this is **architectural, version-independent**. | **2/10** |

Note: `coupled_with` collapsed 919→25 (1.0's noise filtering) — git-coupling is now far
more conservative and less useful as a ranking signal than on 0.2.2.

### Final recommendation (supersedes §6)
1. **Standardize on Axon 1.0.1**, integrate via **`axon serve`/`host` MCP/HTTP** —
   the CLI Cypher/query/context surface is unreliable on this build. MCP tools
   available: `axon_query, axon_context, axon_impact, axon_cypher, axon_dead_code,
   axon_list_repos, axon_detect_changes`.
2. **Drop pgvector / the semantic Signal Index from Horus v0.** Axon's hybrid search
   (9/10) covers signal→code fuzzy matching. Delegate semantic search to Axon.
3. **Delegate log ownership to Axon Cypher** (reverse lookup on structured codes).
4. **`axon_detect_changes`** (git diff → affected symbols/flows) is a free
   incident→commit correlation primitive — wire it into the investigation pipeline.
5. The **queue-boundary bridge (Test 6) is the one irreducible thing Horus must build**,
   confirmed on latest. Everything else delegates to Axon.
6. ⚠️ **Risk:** the installed 1.0.1's CLI read-path is buggy and its schema lags its own
   docs — Axon is a fast-moving 3-week-old project. Pin the version, integrate through
   the HTTP/MCP contract (the stable surface), and add a schema contract-test.

### Minimum supplemental layer — final answer
If Horus ships tomorrow on Axon 1.0.1, the **entire** required supplemental build is:

> **A queue-boundary stitcher**: one pass that parses queue-name literals
> (`registerQueue({name})`, `@Processor('x')`, `@InjectQueue('x')`, `queue.add('x')`)
> out of Axon's `content` and synthesizes `producer →[enqueues]→ queue →[consumed_by]→
> worker` edges — plus the incident/time correlation + AI narrative layers that were
> never Axon's job.

No pgvector. No log index. No metric index. No symbol/relationship indexing. The
"Signal Index" collapses to a **queue map + correlation/AI**.

