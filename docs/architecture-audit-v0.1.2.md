# Horus Architecture Audit — v0.1.2

> Audited by Claude Sonnet 4.6 on 2026-06-16.
> All claims are grounded in source files; line numbers reference the state at commit `2dc65d3`.

---

## 1. Architecture Map

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/horus (CLI binary)                                         │
│    packages/cli/src/commands/                                    │
│      investigate.ts  ask.ts  score.ts  postmortem.ts  replay.ts │
│      timeline.ts  changes.ts  status.ts  doctor.ts  readiness.ts│
└───────────────────────┬──────────────────────────────────────────┘
                        │ calls
┌───────────────────────▼──────────────────────────────────────────┐
│  packages/engine                                                 │
│    engine.ts          — investigation orchestration pipeline     │
│    hypotheses.ts      — generate fixed 6-category hypothesis set │
│    validate.ts        — check evidence IDs in present set        │
│    score-cause.ts     — 9-factor cause ranking                   │
│    score.ts           — quality scoring of full report           │
│    confidence.ts      — weighted evidence confidence             │
│    correlate.ts       — group evidence, identify chains          │
│    gaps.ts            — detect missing evidence dimensions       │
│    graph.ts           — infrastructure topology from evidence    │
│    timeline.ts        — chronological event ordering             │
│    git-collector.ts   — bounded git log + diff stats             │
│    postmortem.ts      — deterministic Markdown draft             │
│    refine.ts          — keyword-filter view ("ask")              │
│    memory.ts          — similar incident recall + storage        │
└───────────────────────┬──────────────────────────────────────────┘
            ┌───────────┴─────────────────┐
            │                             │
┌───────────▼───────────────┐ ┌───────────▼─────────────────────────┐
│  packages/connectors      │ │  packages/ai                        │
│    axon/       code graph │ │    contract.ts  renderNarrative()   │
│    elasticsearch/ logs    │ │    anthropic.ts  NarrativeProvider  │
│    mongodb/    state      │ │    local-providers.ts  (registry    │
│    grafana/    metrics    │ │      only — no detection impl)      │
│    bullmq/     queues     │ └─────────────────────────────────────┘
│    git/        history    │
└───────────────────────────┘
            │
┌───────────▼───────────────┐
│  packages/db (Drizzle)    │
│    investigations  evidence│
│    findings  hypotheses   │
│    queue_edges            │
└───────────────────────────┘
```

**Package responsibilities**

| Package | Owns |
|---|---|
| `packages/core` | Config loading, evidence types, discovery, git primitives, CODEOWNERS |
| `packages/connectors` | Axon HTTP client, ES/Mongo/Grafana/BullMQ/Redis adapters, connector factory |
| `packages/engine` | Full investigation pipeline, scoring, hypotheses, postmortem, refine |
| `packages/ai` | NarrativeProvider contract + Anthropic adapter + local provider registry |
| `packages/db` | Drizzle schema, persist/query functions for investigations |
| `packages/cli` | Command wiring only — no business logic |
| `apps/horus` | Binary entrypoint (tsup bundle) |

---

## 2. Evidence Collection — Exact Location and Flow

All evidence collection is in **`packages/engine/src/engine.ts:investigate()`**, executed in this order:

### Phase sequence

| Step | Lines | Evidence kind | What is collected |
|---|---|---|---|
| a. Seeds | 270–299 | — | `code.searchSymbols(hint, 5)` → `rankSeeds()` |
| b. Context | 308–313 | — | callers, callees, flows, queue edges from DB |
| c. Changes | 329–337 | — | `code.detectChanges({ base: since, compare: 'HEAD' })` only when `looksDiffable(since)` is true |
| d. Symbol evidence | 339–345 | `symbol` | seed symbol + snippet |
| d. Flow evidence | 348–356 | `flow` | execution flows the seed participates in |
| d. Impact evidence | 358–363 | `impact` | blast-radius **count only** — not a file list |
| d. Queue-edge evidence | 365–387 | `queue-edge` | producer/worker/queue name per edge |
| d. Change evidence | 388–401 | `commit` | **only counts**: `{added: N, removed: N, modified: N}` |
| e0. Log evidence | 411–505 | `log` | ES error signatures (key, count, firstSeen, lastSeen, services, isNew, ratio) — classified direct/ambient |
| e0b. State evidence | 509–530 | `state` | MongoDB collection signals (counts, anomalies) |
| e0c. Queue runtime | 535–566 | `queue-state` | BullMQ depth/failed/delayed per queue |
| e0d. Metric evidence | 572–672 | `metric` | Grafana anomalies (latency-spike, error-rate-change, queue-growth) |
| e0e. Ownership | 678–689 | — | git history → `likelyMaintainer` |
| e0f. Normalize | 694 | — | fill `priority` + `category` fields |
| e0g. Graph | 697 | — | infrastructure topology nodes + edges |
| HOR-94 | 1063–1070 | — | `collectGitChanges()` → `report.recentChanges` (**display-only, not in evidence[]**) |

### Evidence schema (`packages/core/src/evidence.ts`)

```typescript
interface Evidence {
  id: string;                    // UUID — also DB primary key
  source: ProviderKind;          // 'code' | 'logs' | 'state' | 'queue' | 'metrics' | 'history'
  kind: EvidenceKind;            // 'symbol' | 'flow' | 'impact' | 'queue-edge' | 'commit' |
                                 //   'log' | 'metric' | 'state' | 'queue-state' | 'redis-key'
  title: string;
  relevance: number;             // 0–1 heuristic weight
  payload: unknown;              // raw provider data
  links: EvidenceLinks;          // symbolId | file | line | queueName | traceId
  provenance: { query, collectedAt };
  timestamp?: string;            // for temporal ordering
  // Normalized post-collection:
  priority?: 'critical'|'high'|'medium'|'low'|'info';
  category?: string;
  isNew?: boolean;               // for log evidence
  ratio?: number;                // spike ratio for log evidence
}
```

### What is NOT in the evidence model

- Actual changed file paths from `--since` (only counts are stored in `commit` evidence)
- Symbol → file ownership mapping per evidence item
- Log message → code path mapping
- Metric → service → symbol mapping (done ad-hoc in engine.ts for scoring, never stored)
- Trace IDs (the `links.traceId` field exists but no connector fills it)

---

## 3. Judging / Reasoning Engine

### Hypothesis generation (`packages/engine/src/hypotheses.ts`)

`generateHypotheses()` emits exactly **6 fixed categories**, always:

| Category | Condition for confidence > baseline | Default confidence |
|---|---|---|
| `deployment-regression` | `commitEvs.length > 0` | 0.15 (no commit) / 0.50 (has commit) |
| `queue-backlog` | `backlogEvIds.length > 0` per queue | 0.35 / 0.70 |
| `worker-slowdown` | `slowdownEvIds.length > 0` per queue | 0.30 / 0.55 |
| `external-api-latency` | `latencyMetricEvIds.length > 0` | 0.20 / 0.55 |
| `retry-storm` | **never** | always 0.15 |
| `infrastructure` | **never** | always 0.15 |

The hypotheses are **fixed templates**. They cannot be derived from, surprised by, or exceed what these six categories cover.

### Hypothesis validation (`packages/engine/src/validate.ts`)

`validateHypotheses()` is a pure ID-intersection check:

```typescript
const supportingPresent = h.supportingEvidenceIds.filter(id => present.has(id)).length;
const contradictingPresent = h.contradictingEvidenceIds.filter(id => present.has(id)).length;

confidence = clamp01(h.confidence + 0.15 * supportingPresent - 0.3 * contradictingPresent);

if (contradictingPresent > 0 && confidence < 0.1) verdict = 'eliminated';
else if (contradictingPresent > 0)                 verdict = 'weakened';
else if (supportingPresent > 0)                    verdict = 'supported';
else                                               verdict = 'unconfirmed';
```

**Why investigations end with all hypotheses unconfirmed:**

- `retry-storm` and `infrastructure` always have `supportingEvidenceIds = []` — there is no code path that ever populates them. They are structurally incapable of leaving `unconfirmed`.
- `deployment-regression` only gets supporting IDs when `--since` produces a valid `commit` evidence item.
- `queue-backlog` and `worker-slowdown` need live Redis/BullMQ or Grafana metrics evidence IDs.
- `external-api-latency` needs Grafana latency metric anomaly IDs.

Without ES + Grafana + Redis all connected and returning anomalies, 4–6 hypothesis categories are perpetually `unconfirmed`.

### Cause scoring (`packages/engine/src/score-cause.ts`)

Nine heuristic factors applied to a hand-coded `baseScore`:

| Factor | Max delta |
|---|---|
| 1. Evidence quality (priority × relevance vs 0.5 baseline) | ±0.10 |
| 2. Source diversity (2+ independent providers) | +0.05 / +0.10 |
| 3. Graph proximity (infrastructure implication score) | up to +0.10 |
| 4. Runtime signals (recency, isNew, spike ratio) | ±0.08 |
| 5. Blast radius | up to +0.05 |
| 6. Signal strength (−0.05 penalty for all-structural) | ±0.05 |
| 7. Finding uncertainty (penalty when related findings are low-confidence) | up to −0.06 |
| 8. Provider reliability (avg reliability of evidence sources) | ±0.03 |
| 9. Request context (queried service implicated in graph?) | +0.04 |
| Single-source ceiling (caps at 0.84 when only one provider) | — |

**Base scores in engine.ts are low by design** (0.15–0.45). Factor adjustments are small. A pure Axon-only investigation (no runtime connectors) produces all causes in the `observation` band (< 0.40). The `highly-likely` band (≥ 0.85) is architecturally unreachable without multiple connected runtime providers.

### Is there a causal graph or Bayesian model?

No. There is:
- An **infrastructure topology graph** (`graph.ts`) — nodes for services, queues, workers, collections. Used only in `score-cause.ts` Factor 3 for a ±0.10 adjustment.
- **9 independence-assumed heuristic factors** — no correlation model between them.
- **No Bayesian network**, no causal chain construction, no counterfactual reasoning.

---

## 4. AI Layer

### Where `--ai` is implemented

`packages/cli/src/commands/investigate.ts:125–153` (identical code in `replay.ts:41–69`).

### Execution sequence

```
investigate() → deterministic report
     ↓
buildNarrativeInput(report)          strips payload, sends only title/kind/id
     ↓
AnthropicNarrativeProvider.render()  POST /v1/messages, 1024 max_tokens
     ↓
validateNarrative()                  citation IDs, confidence ceiling, services
     ↓
print narrative below deterministic report
     ↓
NOTHING STORED — AI output is ephemeral
```

### Default model

`claude-opus-4-8` — hardcoded in `packages/ai/src/anthropic.ts:45`. Must pass `--ai-model` to override. No cost warning.

### What AI receives (`packages/cli/src/commands/investigate.ts:10–32`)

```typescript
evidence: report.evidence.map((e) => ({
  id: e.id,
  kind: e.kind,
  title: e.title,
  // NO payload, NO excerpts, NO file paths, NO log messages
})),
knownServices: report.input.service ? [report.input.service] : [],  // empty when --service not set
suspectedCauses: report.suspectedCauses.map(c => ({ label: c.title, score: c.finalScore, evidenceIds: c.sourceEvidenceIds })),
deterministicSummary: report.summary,
findings: report.findings.map(f => ({ title: f.title, evidenceIds: f.evidenceIds })),
```

AI does NOT receive: log message bodies, metric values, file paths, changed symbols, error stack traces, queue depths, MongoDB document samples.

**AI cannot discover new causes or update hypothesis verdicts.** It can only narrate what is already determined.

### Why AI provider failure shows only "Provider threw an error"

`packages/ai/src/contract.ts:217–222` — the original exception is swallowed:

```typescript
} catch {
  return {
    output: deterministicFallback(input),
    fromProvider: false,
    validationErrors: ['Provider threw an error'],  // original error discarded
  };
}
```

`packages/cli/src/commands/investigate.ts:134` prints only `validationErrors[0]` — no underlying detail.

### Why `providers doctor` always reports unavailable

`packages/cli/src/commands/providers-doctor.ts:21–27`:

```typescript
export function buildProviderResults(registry: LocalProviderRegistry): LocalProviderResult[] {
  return registry.providers.map((p) => ({
    id: p.id,
    status: 'unavailable' as const,   // hardcoded — never probes anything
    detail: `install the ${p.displayName} binary to use this provider`,
  }));
}
```

No PATH check, no env var check, no HTTP ping. Every provider is always `unavailable`. The command then prints "Detection not yet implemented" explicitly (`providers-doctor.ts:49`).

### AI narrative persistence — replay behavior

AI narrative is **never persisted**. The `investigations.report` column (written at `engine.ts:1139`) stores the deterministic report only.

`horus replay <id> --ai` re-calls the API fresh from the stored report data. The narrative from a previous `horus investigate --ai` is not stored and cannot be replayed without a new API call.

---

## 5. `--since` and Change Evidence

### Two separate code paths

**Path 1 — `code.detectChanges()` (Axon diff, `engine.ts:329–337`)**

```typescript
if (input.since !== undefined && looksDiffable(input.since)) {
  changes = await code.detectChanges({ base: input.since, compare: 'HEAD' });
}
```

`looksDiffable()` returns true for any alphanumeric string (including `"24h"`, `"7d"`). When `since = "24h"`, Axon cannot resolve it as a git ref → throws → `changes = null`.

When it succeeds (valid tag/SHA/branch), it creates ONE evidence item:

```typescript
mkEv('commit', `Change range ${input.since}..HEAD: +${addedN} -${removedN} ~${modifiedN} symbol(s)`,
  { added: addedN, removed: removedN, modified: modifiedN }, {})
```

This contains **only counts — no file names, no changed symbol IDs**.

**Path 2 — `collectGitChanges()` (display-only, `engine.ts:1063–1070`)**

```typescript
if (deps.repoPath && input.since) {
  recentChanges = await collectGitChanges({ repoPath: deps.repoPath, since: input.since });
}
```

Collects actual commits + file diff stats into `report.recentChanges`. This is shown in the rendered report but is **not in `report.evidence`**, not passed to hypothesis generation, not passed to cause scoring, not consumed by the gap detector.

### Why "Recent changes" appears but "deployment/change data is missing"

If `--since 24h` is given:
- `looksDiffable("24h")` = true (alphanumeric, matches the regex) → `code.detectChanges({ base: '24h' })` → Axon fails on `"24h"` as a git ref → `changes = null` → no `commit` evidence created
- `collectGitChanges({ since: '24h' })` → `isRefLike("24h")` = true (same regex issue) → tries `git log 24h..HEAD` → git fails → `recentChanges` with `truncated = true`
- Gap detector: `hasCommit = false` → reports "deployment records" gap

Both `looksDiffable` and `isRefLike` use the same regex and both misclassify duration strings as ref-like.

### What `--since` needs to actually influence hypothesis confidence

Currently the `commit` evidence payload `{added, removed, modified}` tells the hypothesis engine only that "some change happened somewhere." The engine needs to know:

1. Which files changed (in `recentChanges.changedFiles`)
2. Whether any of those files overlap with the seed's blast-radius files (needs Axon to return file paths in `impact`, not just a count)
3. If there is overlap, the `deployment-regression` hypothesis should reflect that fraction

Today neither step 2 nor step 3 is implemented.

---

## 6. Command Behavior — Exact Implementation

| Command | What it actually does |
|---|---|
| `horus investigate <hint>` | Full deterministic pipeline: seed resolution → evidence collection → hypotheses → validation → cause scoring → gap analysis → persist to DB → print report |
| `horus investigate --ai` | Same as above, then calls Anthropic with evidence titles/kinds, appends narrative to stdout. AI output NOT stored. |
| `horus ask <id> <directive>` | Loads persisted report. Calls `refineInvestigation()` — a **pure keyword filter** (`focus on queue`, `ignore deployment`). Returns filtered subset of existing evidence/hypotheses. No AI, no re-query, no new reasoning. |
| `horus score <id>` | Loads persisted report. Calls `scoreInvestigation()`: 5 weighted dimensions — evidence support (0.2), hypothesis discrimination (0.25), root-cause confidence (0.25), evidence completeness (0.2), actionability (0.1). |
| `horus postmortem <id>` | Loads persisted report. Calls `generatePostmortem()` — deterministic Markdown from stored report fields. No AI. |
| `horus replay <id>` | Loads stored report JSON, re-renders it. No re-query. With `--ai`, calls Anthropic fresh from stored inputs. AI narrative from original `investigate --ai` is not replayed. |
| `horus timeline <service>` | Calls Axon's change timeline reconstruction. Shows git-derived change events for a service. Independent of `investigate`. |
| `horus what-changed <base> [compare]` | Calls `changeImpact()` via Axon. Shows symbol-level diff between two refs. Independent of `investigate`. |
| `horus readiness` | Checks: CLI binary present, DB reachable + schema applied, local config file exists, horus-source version correct, connector URLs configured. Does NOT ping ES/Grafana/Redis. |
| `horus doctor` | Checks: CLI version, git root, local config file, global config, DB reachable. Subset of `readiness`. |
| `horus status` | Pings all configured environments' connectors. ES and Grafana are actually HTTP-probed. MongoDB and Redis show `pending` — **not probed**. |

---

## 7. Smoke-Test Findings — Verified in Code

### `ask` is deterministic filtering, not AI reasoning

**Confirmed.** `packages/engine/src/refine.ts:refineInvestigation()` is a pure keyword→category→kind filter. The function signature comment: "Pure and synchronous; no I/O, no randomness, no AI/LLM." The `ask.ts` command calls only `refineInvestigation` and `renderRefined`. Zero AI involvement.

### AI is appended as narrative, not the judging engine

**Confirmed.** `packages/cli/src/commands/investigate.ts:125–153`. The AI call happens after `renderReport(report)` is already printed. `report.hypotheses`, `report.confidence`, and `report.suspectedCauses` are never modified by AI. The `contract.ts` explicitly states: "AI never replaces deterministic scoring. It only annotates it."

### `--since` is displayed but not consumed by hypothesis gaps

**Confirmed.** `report.recentChanges` (from `collectGitChanges`) is used only by `renderReport` for display. It is not passed to `generateHypotheses`, `validateHypotheses`, `rankCauses`, or `detectMissingEvidence`. The `commit` evidence from `code.detectChanges` IS used by `generateHypotheses` but only as an existence flag — the payload `{added, removed, modified}` is never decomposed into file-level evidence.

### Investigation scoring exposes weak hypothesis discrimination

**Confirmed.** `packages/engine/src/score.ts:39`: `discriminationValue = resolved / total`. Without runtime connectors, `retry-storm` and `infrastructure` are always `unconfirmed` (no evidence path exists for them), other categories need specific connector anomalies. Typical discrimination score without full connector suite: 0/6 = 0. The discrimination (0.25) + root-cause confidence (0.25) dimensions together carry 50% of the score weight — both zero when hypotheses are unconfirmed.

### Postmortem confuses structural impact with runtime/user impact

**Confirmed.** `packages/engine/src/postmortem.ts:80–88`:

```typescript
const impactEvidence = r.evidence.filter((e) => e.kind === 'impact');
// payload: { affected: N }  ← code symbol count, not user-facing impact
lines.push(`- \`${shortId(e.id)}\` ${e.title}`);
// title: "Impact of X: N affected symbol(s)"  ← blast radius, not error count
```

The Impact section shows code-graph depth (how many symbols would be affected by a change), not user-facing metrics (error rates, affected user count, latency degradation).

### Connector health inconsistent across commands

**Confirmed:**
- `status.ts`: ES → `logsProvider.health()` (HTTP ping); Grafana → `metricsProvider.health()` (HTTP ping); MongoDB → hardcoded `mark('pending')`; Redis → hardcoded `mark('pending')`
- `readiness.ts`: only checks config key presence, never pings
- `doctor.ts`: only checks config file structure, never pings
- `providers-doctor.ts`: always returns `unavailable` for all providers, no detection

### Default AI model is `claude-opus-4-8`

**Confirmed.** `packages/ai/src/anthropic.ts:45`. No fallback, no cost warning, no automatic model selection.

### AI provider failure shows only "Provider threw an error"

**Confirmed.** `packages/ai/src/contract.ts:218`: `validationErrors: ['Provider threw an error']`. Original exception silently discarded. `investigate.ts:134`: shows only `validationErrors[0]` with no underlying detail.

### AI narrative not persisted, not replayed

**Confirmed.** `engine.ts:1139` writes only the deterministic `report`. `replay.ts:44` re-calls `renderNarrative` fresh when `--ai` is given — it does not load a stored narrative.

---

## 8. Recommended Architecture

### Core Problem Statement

Evidence collection is solid. Judgment is shallow because:

1. Evidence is a flat list, not a graph with typed links to code symbols
2. Hypotheses are fixed templates that can only be supported by pre-specified evidence kind/ID pairs
3. No mechanism to ask "do the changed files overlap with the seed's affected symbols?"
4. AI sees titles and scores, not evidence content — it can narrate but not reason
5. AI output is ephemeral — it cannot improve future investigations

### Proposed Pipeline

```
PHASE 1 — COLLECTION (unchanged)
  engine.ts collects ES logs, Mongo state, BullMQ queues, Grafana
  metrics, Axon symbols/flows/impact, git changes
  Output: flat Evidence[]
          ↓
PHASE 2 — CORRELATION (improve existing correlate.ts)
  Build EvidenceGraph with typed links:
    symbol → flows that include it
    symbol → log signatures from that symbol's file/service
    symbol → changed files that touch it (--since intersection)
    symbol → metric anomalies from the service that owns it
    queue  → runtime state (depth, failures)
  Output: EvidenceGraph (nodes = evidence items, edges = typed links)
          ↓
PHASE 3 — DETERMINISTIC JUDGMENT (new)
  For each hypothesis category, run a rule engine:
    deployment-regression:
      support if changedFiles ∩ seedBlastRadiusFiles ≠ ∅
      support strength = overlap fraction
    queue-backlog:
      support if queue.waiting > threshold AND queue in seed's path
    worker-slowdown:
      support if worker processing time metric spike AND same queue
    external-api-latency:
      support if latency metric spike on service in seed's callees
    retry-storm:
      support if log isNew AND ratio > 3 AND queue failure > 50
    infrastructure:
      support if metric shows DB/Redis latency spike
  Each rule produces: confidence delta + contributing evidence IDs
  Output: Hypothesis[] with updated confidences + support chains
          ↓
PHASE 4 — CAUSE CHAIN CONSTRUCTION (new)
  For each supported hypothesis, build ordered chain:
    trigger → propagation → symptom
    Example: commit(f.ts) → impact(OrderService) → queue-backlog
             → log(TimeoutError) → metric(latency-spike)
  Output: CauseChain[] stored in InvestigationReport
          ↓
PHASE 5 — AI JUDGMENT (structured, not just narrative)
  Send AI the cause chain + full evidence payloads (redacted):
    - actual log messages (first 200 chars)
    - metric values + baseline
    - changed file names + insertions/deletions
    - MongoDB collection anomaly descriptions
  Ask AI to return structured output:
    { hypothesisVerdicts: [{id, verdict, rationale, confidence}],
      rootCause: {statement, confidence, chain},
      uncertainties: string[] }
  Merge AI verdicts INTO the report (AI can upgrade 'unconfirmed'
  to 'supported' with rationale, capped by evidence ceiling)
  AI output is PERSISTED alongside the deterministic report
  Output: report.aiJudgment (only when --ai was used)
          ↓
PHASE 6 — NARRATIVE (separate from judgment)
  Use AI judgment (if present) OR deterministic cause chain
  to produce the postmortem / ask / replay narrative
  Narrative cites cause chain IDs, not raw evidence IDs
```

---

## 9. Implementation Tickets — Prioritized

### P0 — Unblock honest scoring

**HOR-A: Fix `--since` duration/ref parsing**

- `engine.ts`: add `parseSinceArg()` that correctly classifies `24h`/`7d` as durations and `v1.2.0`/`abc1234` as refs
- Fix `looksDiffable` and `isRefLike` — they share the same regex bug that misclassifies durations as refs
- Duration strings → `gitLog(repoPath, { since: "N units ago" })`; ref strings → range diff
- Ensures `--since 24h` produces commit evidence and removes the false "deployment records" gap
- Owner: HOR-CORE

**HOR-B: Wire `recentChanges` into hypothesis confidence**

- Pass `recentChanges.changedFiles` to `generateHypotheses`
- Add file-overlap calculation against impact blast radius (requires Axon `code.impact()` to return file paths, not just a count)
- `deployment-regression` confidence becomes proportional to actual seed overlap, not just "a commit exists"
- Owner: HOR-CORE

**HOR-C: Add evidence paths for `retry-storm` and `infrastructure`**

- `hypotheses.ts`: add log-ratio + queue-failure evidence IDs to `retry-storm.supportingEvidenceIds`
- `hypotheses.ts`: add Redis connection error + DB latency evidence IDs to `infrastructure.supportingEvidenceIds`
- These are always `unconfirmed` today even when matching evidence is present
- Owner: HOR-CORE

### P1 — Make AI useful for judgment

**HOR-D: Add evidence excerpts to AI narrative input**

- `investigate.ts:buildNarrativeInput()`: extract meaningful content from payloads — `sampleMessage` from log evidence, file paths from commit evidence, delta values from metric evidence
- AI currently sees only titles; this gives it actual signal content to reason about
- Owner: HOR-AI

**HOR-E: Structured AI verdict output**

- Change `anthropic.ts:buildPrompt()` to request structured hypothesis verdicts in addition to narrative
- Add `hypothesisVerdicts: [{id, verdict, confidence, rationale}]` to `NarrativeOutput` contract
- Merge AI verdicts into `report.hypotheses` (bounded by deterministic confidence ceiling)
- Owner: HOR-AI

**HOR-F: Persist AI judgment**

- Add `aiJudgment` field to the `report` JSON column (or a dedicated column)
- Store AI verdict result when `--ai` is used
- `replay --ai` returns stored judgment; re-calls API only with `--force-ai`
- Update `migrateReport()` to handle missing `aiJudgment` gracefully
- Owner: HOR-AI + HOR-CORE

### P2 — Fix UX and observability inconsistencies

**HOR-G: Surface real AI error detail**

- `contract.ts:renderNarrative()`: capture and forward the exception message
- `investigate.ts`: show full error string, not just the first validation error
- One-liner fix, high user-facing value
- Owner: HOR-CLI

**HOR-H: Fix postmortem Impact section**

- `postmortem.ts`: rename current section to "Structural blast radius"
- Add "Runtime impact" section using log evidence (total errors, affected services) and metric evidence (error rate delta, latency spike magnitude)
- Owner: HOR-CORE

**HOR-I: Implement `providers doctor` detection**

- `providers-doctor.ts:buildProviderResults()`: check PATH for `codex`, `claude`, `kimi`, `gemini`, `cursor` binaries
- Check `ANTHROPIC_API_KEY` env var for `claude` status (`ready` when key present, `installed` when binary found but no key)
- Owner: HOR-CLI

**HOR-J: Make MongoDB and Redis health-checkable in `horus status`**

- `status.ts:checkEnv()`: MongoDB → brief `listCollections` ping; Redis → `PING` command via ioredis
- Remove hardcoded `mark('pending')` for these two connectors
- Owner: HOR-CLI

**HOR-K: Rename `ask` to reflect what it does**

- `ask` implies interactive AI reasoning — it is a keyword filter
- Update help text: "Filter a saved investigation by topic. For AI reasoning, use `horus investigate --ai`."
- Owner: HOR-CLI

### P3 — Evidence graph and cause chains (longer horizon)

**HOR-L: Evidence graph with typed links**

- Extend `Evidence.links` to include `affectedSymbolIds: string[]`, `relatedLogSignatures: string[]`
- Build during collection in `engine.ts` rather than derived post-hoc
- Owner: HOR-CORE

**HOR-M: Cause chain construction**

- New `packages/engine/src/cause-chain.ts`: given validated hypotheses + evidence graph, build ordered chains (trigger → propagation → symptom)
- Store chains in `InvestigationReport.causeChains`
- Owner: HOR-CORE

---

## 10. Dangerous Assumptions — Needs Further Inspection

1. **Axon `code.detectChanges` return shape** — The `ChangeSet` type is used in `engine.ts` but the Axon HTTP client (`packages/connectors/src/axon/client.ts`) was not read. If Axon returns individual changed symbol IDs (not just counts), the file-intersection logic in HOR-B may already be available. Verify before implementing.

2. **`impact.affectedFiles` vs `impact.affected`** — The impact evidence payload is `{ affected: number }` (a count). HOR-B needs file paths. Whether `code.impact()` returns file paths must be confirmed in `packages/connectors/src/axon/client.ts`.

3. **`packages/stitcher`** — Not read. It presumably handles queue-edge stitching from Axon. Any change to queue evidence must be coordinated with stitcher.

4. **DB schema for `aiJudgment` persistence** — The `report` JSON column on the `investigations` table currently stores the full `InvestigationReport`. Extending it requires a schema migration and `migrateReport()` updates.

5. **Single-source ceiling in `score-cause.ts:484`** — When Axon is the only provider, the single-source ceiling caps all causes at 0.84. Intentional, but users may interpret as a bug when strong structural signals can't reach `highly-likely`.

6. **Evidence ID stability** — Evidence IDs are `crypto.randomUUID()` at collection time, correctly documented as non-deterministic across runs. Hypothesis `supportingEvidenceIds` only work within a single run. This is fine but means `replay` showing different hypothesis confidences across re-runs is expected behavior, not a bug.
