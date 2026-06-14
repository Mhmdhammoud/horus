# Cause Scoring Engine v2

## What it is

`score-cause.ts` is the deterministic, explainable cause-ranking module (HOR-15). It replaces scattered heuristic `score` values inside `engine.ts` with a principled, factor-based system that assigns each suspected cause a `finalScore`, a qualitative `band`, and a human-readable `explanations` list.

Every boost and penalty is recorded in the explanation list so the scoring logic can be read and audited without source code.

## Score bands

| Band | finalScore range | Meaning |
|------|-----------------|---------|
| `highly-likely` | ≥ 0.85 | Strong multi-source confirmation; treat as confirmed pending fix |
| `likely` | ≥ 0.65 | Evidence-backed with corroboration; prioritise for investigation |
| `possible` | ≥ 0.40 | Plausible but not confirmed; investigate if higher-ranked causes are ruled out |
| `observation` | < 0.40 | Structural or weak signal only; keep for context |

## Types

```ts
// packages/engine/src/score-cause.ts

type CauseBand =
  | 'highly-likely'   // ≥ 0.85
  | 'likely'          // ≥ 0.65
  | 'possible'        // ≥ 0.40
  | 'observation';    // < 0.40

interface ScoreExplanation {
  factor: string;   // stable factor identifier, e.g. 'evidence-quality'
  delta: number;    // signed adjustment (+boost / −penalty)
  reason: string;   // human-readable justification
}

interface CauseCandidate {
  id: string;
  title: string;
  category: string;
  sourceEvidenceIds: string[];
  affectedNodeIds: string[];     // graph node IDs implicated by this cause (derived from graph)
  baseScore: number;             // heuristic prior before factor adjustments (0–1)
  finalScore: number;            // clamped 0–1 after all adjustments and post-delta constraints
  confidence: number;            // alias for finalScore
  band: CauseBand;
  explanations: ScoreExplanation[];
  metadata?: Record<string, unknown>;
}

interface CauseInput {
  id: string;
  title: string;
  category: string;
  sourceEvidenceIds: string[];
  affectedNodeIds?: string[];    // if omitted, derived from the graph automatically
  baseScore: number;             // domain-specific prior (queue depth, blast radius, etc.)
  metadata?: Record<string, unknown>;
}

// Minimal finding shape accepted by the scorer. Structurally compatible with
// ReportFinding from types.ts (not imported to avoid a circular dependency).
interface ScoringFinding {
  kind: string;
  confidence: number;
  evidenceIds: string[];
}

// Investigation request forwarded to the scorer for Factor 9.
interface ScoringRequest {
  hint?: string;
  service?: string;
}

interface ScoringContext {
  evidence: Evidence[];                      // normalized evidence from the investigation
  graph: InvestigationGraph;                 // infrastructure topology (HOR-14)
  findings?: ScoringFinding[];               // engine findings; used by finding-uncertainty (Factor 7)
  providerReliability?: Record<string, number>; // source ID → 0–1; used by Factor 8
  request?: ScoringRequest;                  // investigation request; used by Factor 9
  now?: string;                              // ISO-8601 reference timestamp (injectable for tests)
}
```

## Scoring formula

```
rawScore  = clamp01(baseScore + Σ(factor deltas))
finalScore = apply post-delta constraints(rawScore)
```

Seven factors run against the attached evidence and graph. Each returns a `ScoreExplanation` or `null` (when the factor has nothing to say). Factors that return `null` are excluded from the `explanations` list.

After all factor deltas are summed, post-delta constraints (see below) may clamp the result further before `finalScore` is set.

| # | Factor | Key | Max delta | When it fires |
|---|--------|-----|-----------|---------------|
| 1 | Evidence quality | `evidence-quality` | ±0.50 | Any non-info evidence attached; penalizes all-info |
| 2 | Source diversity | `source-diversity` | +0.10 | 2+ independent provider kinds (logs, queue, state, …) |
| 3 | Graph proximity | `graph-proximity` | +0.10 | `maxImplicationScore` > 0 for evidence IDs in implicated graph nodes |
| 4 | Runtime signals | `runtime-signals` | +0.10 / −0.05 | Recent evidence boosts; stale evidence (3–7d: −0.02, >7d: −0.05) decays |
| 5 | Blast radius | `blast-radius` | +0.05 | `metadata.blastRadius` > 0 |
| 6 | Signal strength | `signal-strength` | +0.03 / −0.05 | High-relevance anomaly (+0.03); structural-only (−0.05) |
| 7 | Finding uncertainty | `finding-uncertainty` | −0.06 | Relevant findings all have confidence < 0.60 |
| 8 | Provider reliability | `provider-reliability` | ±0.03 | avg source reliability ≥ 0.80 (+0.03) or < 0.50 (−0.03) |
| 9 | Request context | `request-context` | +0.04 | Queried service is an implicated `service` graph node for this cause |

### Factor 1 — Evidence quality (severity × confidence)

Computes a priority-weighted average relevance of non-structural evidence attached to the cause. Compares the weighted average against a 0.50 neutral baseline.

Priority weights:

| Priority | Weight |
|----------|--------|
| `critical` | 1.00 |
| `high` | 0.90 |
| `medium` | 0.75 |
| `low` | 0.50 |
| `info` | excluded |

When all attached evidence has `priority: 'info'`, a −0.05 penalty fires instead. This prevents structural evidence (queue-edge, symbol, flow, impact — always `priority: 'info'`) from inadvertently boosting a cause.

### Factor 2 — Source diversity

Two independent providers corroborating the same cause is more reliable than a single provider. The factor counts distinct `evidence.source` values among attached items.

- 2 sources → +0.05
- 3+ sources → +0.10

### Factor 3 — Graph proximity

Delegates to `maxImplicationScore(graph, sourceEvidenceIds)` from the Investigation Graph (HOR-14). Only infrastructure nodes with `implicated: true` (implicationScore ≥ 0.6) contribute. The delta is `implicationScore × 0.10`, capped at +0.10.

### Factor 4 — Runtime signals (recency + recurrence)

Two sub-signals combined into one factor:

**Recency** — age of the most recent evidence timestamp relative to `ctx.now`:
- ≤ 1 hour: +0.05
- ≤ 24 hours: +0.02
- 24 h – 3 days: 0 (neutral)
- 3 – 7 days: −0.02 (stale — may predate the current incident)
- > 7 days: −0.05 (very stale — likely predates the current incident)

**Recurrence** — for `log` evidence, reads the top-level `Evidence` fields `isNew` and `ratio` (normalized from the provider by `engine.ts`, not from `ev.payload`):
- `isNew: true`: +0.05 (new error signature, never seen before)
- `ratio ≥ 3.0`: +0.03 (error spike)

The two sub-signals are added. A new, recent log signature can produce a +0.10 combined delta. A stale single-source log entry can bottom out at −0.05.

### Factor 5 — Blast radius

Large fan-out of affected symbols increases propagation risk. Reads `metadata.blastRadius` (a count of affected symbols, from `impact.affected` in the engine):

```
delta = clamp(blastRadius / 20, 0, 1) × 0.05
```

Capped at +0.05 (for ≥ 20 affected symbols). This intentionally modest weight ensures blast radius alone cannot elevate a structural cause to "likely".

### Factor 8 — Provider reliability

Different evidence sources have different intrinsic reliability. A structured queue-state snapshot is more reliable than log-scraping with potential gaps. The factor reads `ScoringContext.providerReliability` — a map of `source` ID → 0–1 score built by `engine.ts` from the set of connected providers.

Default reliability per provider kind (set by `engine.ts`):

| Provider kind | Default reliability |
|---------------|-------------------|
| Queue runtime | 0.90 |
| State (MongoDB) | 0.85 |
| Code (static analysis) | 0.80 |
| Logs (Elasticsearch) | 0.70 |
| Unknown / unlisted | 0.65 |

Score thresholds:
- avg ≥ 0.80 → +0.03
- 0.50 ≤ avg < 0.80 → null (neutral)
- avg < 0.50 → −0.03

When `ctx.providerReliability` is absent, the factor is skipped entirely.

### Factor 9 — Request / implicated-path context

When the investigation was scoped to a specific service (via `InvestigationInput.service`), the scorer checks whether that service appears as an implicated `service`-type node in the graph whose `evidenceIds` overlap with this cause's `sourceEvidenceIds`. This is complementary to graph-proximity (which measures implication strength for any node): request-context rewards causes that land on the exact service the operator was investigating.

- Queried service matches an implicated graph service node for this cause → +0.04
- No `ctx.request.service` → null (hint-only queries are too loose for deterministic matching)
- Service node not implicated, or evidence doesn't overlap → null

### Factor 6 — Signal strength

Guards against structural-only evidence misleading the score:

- All attached evidence is structural (`symbol`, `flow`, `impact`, `queue-edge`): −0.05
- Any attached evidence has `relevance ≥ 0.85` and is not structural: +0.03

These are mutually exclusive (structural evidence can't also be high-relevance anomaly evidence).

### Factor 7 — Finding uncertainty

Engine findings are deterministic interpretations of the same evidence IDs, not independent observations. This factor therefore **never boosts** a score — doing so would double-count one signal. Instead it penalizes causes whose evidence only appears in low-confidence findings.

The factor looks at `ScoringContext.findings` filtered to those with `kind !== 'observation'` whose `evidenceIds` overlap with the cause's `sourceEvidenceIds`.

- No relevant findings, or max finding confidence ≥ 0.60 → 0 (neutral; investigation is confident)
- All relevant findings below 0.60 → negative delta proportional to the gap:

```
delta = −(0.60 − maxConfidence) × 0.10    (max −0.06)
```

When `ctx.findings` is omitted (e.g. calling the scorer outside the engine), the factor is skipped entirely.

## Post-delta constraints

After all seven factor deltas are summed and added to `baseScore`, the following constraint is applied before `finalScore` is set:

### Single-source ceiling

The `highly-likely` band (≥ 0.85) is documented as requiring strong multi-source confirmation. A single provider can accumulate many factor boosts from different angles of the same signal, so candidates whose attached evidence comes from **≤ 1 distinct `source`** are hard-capped at **0.84** regardless of factor totals.

When the ceiling fires, a `single-source-ceiling` explanation is appended with the capping delta.

```json
{ "factor": "single-source-ceiling", "delta": -0.055, "reason": "Highly-likely requires multi-source corroboration — capped at 0.84 (single provider)" }
```

## Affected node derivation

`CauseCandidate.affectedNodeIds` is derived automatically from the investigation graph when the caller omits `affectedNodeIds` from `CauseInput`. The scorer calls `implicatedNodeIds(graph, sourceEvidenceIds)` (from `graph.ts`) which returns IDs of all implicated infrastructure nodes whose `evidenceIds` overlap with the cause's source evidence.

Callers can still supply explicit `affectedNodeIds` to override derivation.

## Public API

```ts
// Score a single cause
scoreCause(input: CauseInput, ctx: ScoringContext): CauseCandidate

// Score, sort, and return the top N (default 3)
rankCauses(inputs: CauseInput[], ctx: ScoringContext, limit?: number): CauseCandidate[]
```

`rankCauses()` sorts by `finalScore` descending, with `id` as a deterministic tiebreaker. The limit defaults to 3 to match the existing top-3 cause display.

## How engine.ts uses this module

`engine.ts` builds a `CauseInput[]` during the "f. SUSPECTED CAUSES" step. Each cause type sets its own `baseScore` (a domain-specific prior) and passes `metadata.blastRadius` for the blast-radius factor:

| Cause type | baseScore | category |
|------------|-----------|----------|
| Queue runtime backlog/starvation | 0.45–0.65 (wait-count-weighted) | `queue-backlog` |
| Structural queue path | 0.35 | `queue-path` |
| Deployment regression | 0.25–0.30 (queue-correlation bonus) | `deployment-regression` |
| Blast radius fan-out | 0.15–0.20 (queue-correlation bonus) | `blast-radius` |
| Runtime errors + queue path | 0.30 | `error-correlation` |

After building all inputs, the engine calls:

```ts
rankCauses(causeInputs, { evidence, graph, findings })
```

The `findings` field passes engine findings to Factor 7. No manual graph-boost loop or `suspectedCauses.sort()` call.

## Replacing SuspectedCause

`CauseCandidate` replaces the old `SuspectedCause` interface:

| Old field | New field |
|-----------|-----------|
| `statement` | `title` |
| `score` | `finalScore` |
| `evidenceIds` | `sourceEvidenceIds` |

New fields added: `id`, `category`, `affectedNodeIds`, `baseScore`, `confidence`, `band`, `explanations`, `metadata`.

Persisted reports written before HOR-15 are normalized by `migrateReport()` (exported from `@horus/engine`). The migration is idempotent and handles both legacy and partial current-shape entries.

## Determinism guarantee

- `baseScore` is computed from deterministic inputs (queue depth, impact count, queue-hit count)
- `now` can be injected in tests for deterministic recency calculations
- Tiebreaking uses `id.localeCompare()` — IDs are content-derived in `engine.ts` (e.g. `cause:queue-backlog:payments`)
- Factor deltas are deterministic given the same evidence and graph

## Example explanation list

A queue-backlog cause backed by high-relevance queue-state evidence, log evidence from two providers, and a large blast radius:

```json
[
  { "factor": "evidence-quality",      "delta":  0.225, "reason": "2 anomaly evidence item(s); priority-weighted quality 0.73 (+0.22 vs 0.50 baseline)" },
  { "factor": "source-diversity",      "delta":  0.05,  "reason": "Evidence from 2 independent providers (logs, queue) — multi-source corroboration" },
  { "factor": "graph-proximity",       "delta":  0.09,  "reason": "Infrastructure node implication score 0.90 → graph-confirmed path (+9%)" },
  { "factor": "runtime-signals",       "delta":  0.05,  "reason": "Evidence from within the last hour; New error signature (isNew=true)" },
  { "factor": "blast-radius",          "delta":  0.05,  "reason": "Blast radius: 20 affected symbol(s) — fault propagation risk" },
  { "factor": "signal-strength",       "delta":  0.03,  "reason": "2 high-relevance anomaly signal(s) (relevance ≥ 0.85)" }
]
```

`baseScore = 0.45`, `totalDelta = 0.445`, `rawScore = clamp01(0.895) = 0.895`. Two sources → single-source ceiling does not apply. `finalScore = 0.895`, `band = 'highly-likely'`.

Single-source scenario (same cause, one provider):

```json
[
  { "factor": "evidence-quality",      "delta":  0.225, "reason": "..." },
  { "factor": "graph-proximity",       "delta":  0.09,  "reason": "..." },
  { "factor": "runtime-signals",       "delta":  0.05,  "reason": "..." },
  { "factor": "blast-radius",          "delta":  0.05,  "reason": "..." },
  { "factor": "signal-strength",       "delta":  0.03,  "reason": "..." },
  { "factor": "single-source-ceiling", "delta": -0.045, "reason": "Highly-likely requires multi-source corroboration — capped at 0.84 (single provider)" }
]
```

`rawScore = 0.885` → capped to `0.84`, `band = 'likely'`.
