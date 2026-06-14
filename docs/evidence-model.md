# Evidence Model

## Why Evidence exists

Every data source in Horus — code graphs, logs, queue state, MongoDB,
metrics, git history — speaks a different dialect. Without a shared
representation, the investigation engine would accumulate a maze of
provider-specific types: `LogRecord`, `QueueCounts`, `CollectionState`, …
and every downstream step (findings, correlation, rendering, the LLM
prompt) would need to understand each one.

`Evidence` is the single currency that crosses that boundary. Providers
convert their raw data into `Evidence` before handing anything to the
engine. The engine never sees raw provider blobs; the LLM never sees
provider types.

## The evidence pipeline

```
Runtime Providers
    ↓  (provider-specific raw types)
Provider adapters (analyze.ts / normalize.ts per connector)
    ↓  Evidence[]
normalizeEvidence()                    ← cross-provider priority + category
    ↓  Evidence[]  (with .priority and .category filled in)
Findings + correlation + hypotheses
    ↓
InvestigationReport
```

## Evidence fields

| Field | Set by | Purpose |
|-------|--------|---------|
| `id` | engine | Stable, citable key; referenced by findings and suspected causes |
| `source` | provider | Which system produced it (`code`, `logs`, `queue`, `state`, `history`, `metrics`) |
| `kind` | provider | Concrete evidence type (`log`, `symbol`, `queue-state`, `state`, …) |
| `title` | provider | Human-readable one-liner; shown in the report and sent to the LLM |
| `relevance` | provider | 0–1 signal strength; drives ranking and finding confidence |
| `payload` | provider | Typed per kind; opaque to the engine, structured for renderers and the LLM |
| `links` | provider | Back-references to the source (file, line, queue name, trace ID, …) |
| `provenance` | engine | The query that produced this item + collection timestamp for reproducibility |
| `timestamp` | provider | ISO-8601 event time for timeline alignment (optional) |
| `priority` | normalization layer | Investigation-priority tier (`critical` → `info`). Reflects how much attention the item deserves in the investigation — **not** operational severity or production impact. |
| `category` | normalization layer | Broad functional bucket (`queue`, `database`, `cache`, `logs`, `code`, `deployment`, `metrics`) |

`priority` and `category` are intentionally absent from provider code.
They require a cross-provider view — assigning them inside a single
provider would create an implicit coupling to the relevance scale used by
other providers. The normalization layer owns this view.

`priority` derives from evidence `kind` and `relevance`. It is an
investigation-triage signal, not a claim about production impact. A highly
relevant Elasticsearch signature may be `priority: critical` even if it
represents a single occurrence. Downstream consumers that need operational
severity must derive it from the typed `payload`.

## Provider-specific metadata

Each provider attaches its own structured data via `payload`. The engine
treats `payload` as opaque; renderers and the LLM consume it directly.

**BullMQ queue evidence** (`source: 'queue'`, `kind: 'queue-state'`):
```ts
{ queueName, waiting, active, failed, delayed, completed, isPaused }
// or for backlog/starvation signals:
{ queueName, waiting, active }
// for breakdown signals:
{ queueName, topReason, topCount, topPct, totalFailed, breakdown }
```

**MongoDB state evidence** (`source: 'state'`, `kind: 'state'`):
```ts
{ collection, count, dateField, lastActivity, ageHours,
  statusField, statusCounts, anomalies }
```

**Elasticsearch log evidence** (`source: 'logs'`, `kind: 'log'`):
```ts
{ timestamp, level, levelValue, message, service, component,
  eventCode, host, index, raw }
```

**Axon code evidence** (`source: 'code'`, `kind: 'symbol' | 'flow' | 'impact'`):
```ts
// symbol:
{ symbol: { id, name, filePath, startLine, signature }, snippet }
// impact:
{ affected: number }
// flow:
{ flowId, name, steps: string[] }
```

## How to add a new provider

1. **Create a client** (`packages/connectors/src/<name>/client.ts`) — thin
   wrapper around the SDK; no analysis logic.

2. **Create analyze helpers** (`packages/connectors/src/<name>/analyze.ts`) —
   pure functions that turn raw client responses into `Evidence[]`. Keep
   analysis logic here, not in the client or provider.

3. **Create a provider** (`packages/connectors/src/<name>/provider.ts`) —
   implements `Provider` (or a sub-interface like `LogsProvider`); calls
   `analyzeXxx()` and exposes `toEvidence()`.

4. **Register in the factory** (`packages/connectors/src/factory.ts`) — add
   a `xxxForEnv(renv)` builder that reads the connector config and returns
   a provider instance or `null`.

5. **Wire into the engine** (`packages/engine/src/engine.ts`) — add an
   optional dep field to `EngineDeps` and collect evidence in a guarded
   `try/catch` block (provider failures must never abort the investigation).

6. **Let the normalization layer handle priority + category** — you do not
   need to add anything to `normalizeEvidence()` if your provider uses a
   standard `source` value. Check that `categoryFor()` maps your `source`
   correctly; if you need a new `EvidenceCategory` value add it to
   `@horus/core/src/evidence.ts` and add the mapping.

7. **Write tests** — at minimum: an `analyze.test.ts` that covers the pure
   helpers, and entries in `packages/engine/src/normalize.test.ts` for the
   priority/category shape that your evidence produces.

## Priority assignment rules

`priority` measures investigation triage, not production impact. A `critical` item
demands immediate attention during the investigation; it does not claim the system is
down or that an SLA has been breached.

| Kind | Rule |
|------|------|
| `symbol`, `flow`, `impact`, `queue-edge` | Always `info` — structural context, not anomalies |
| `commit` | `medium` if relevance ≥ 0.8; `info` otherwise |
| `queue-state`, `state`, `redis-key` | relevance ≥ 0.9 → `critical`; ≥ 0.8 → `high`; ≥ 0.6 → `medium`; else `info` |
| all other operational signals (`log`, `metric`, …) | relevance ≥ 0.9 → `critical`; ≥ 0.8 → `high`; ≥ 0.6 → `medium`; ≥ 0.4 → `low`; else `info` |

State snapshot kinds (`queue-state`, `state`, `redis-key`) skip the `low` tier. A snapshot
below `medium` is context — it provides background for the investigation rather than
signalling a broken component. `low` is reserved for operational signals where something is
definitively wrong, just minor.

## Category mapping

| `source` | `kind` | `category` |
|----------|--------|------------|
| `queue` | any | `queue` |
| `logs` | any | `logs` |
| `metrics` | any | `metrics` |
| `state` | `redis-key` | `cache` |
| `state` | other | `database` |
| `history` | any | `deployment` |
| `code` | any | `code` |
| anything else | any | `other` |

`'state'` is a shared `ProviderKind` for both MongoDB and Redis. The normalization layer
uses `kind` to distinguish them — `redis-key` evidence maps to `'cache'` so it is never
grouped with database anomalies.
