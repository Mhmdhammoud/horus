/**
 * Public types for the @horus/engine deterministic investigation pipeline (HOR-5).
 * No AI/LLM yet — every field is computed from typed provider evidence.
 */

import type { Evidence, Symbol, Flow } from '@horus/core';
import type { Timeline } from './timeline.js';
import type { CorrelationResult } from './correlate.js';
import type { ValidatedHypothesis } from './validate.js';
import type { SimilarIncident } from './memory.js';
import type { GapAnalysis } from './gaps.js';
import type { InvestigationGraph } from './graph.js';
import type { CauseCandidate } from './score-cause.js';
import type { OwnershipEstimate } from './ownership.js';
import type { RuntimeSourceReport } from './source-status.js';
import type { BoundedGitChange } from './git-collector.js';
import type { CauseChain } from './cause-chain.js';

export type { CauseCandidate };

/** The user-supplied incident hint plus optional scoping. */
export interface InvestigationInput {
  /** Free-text hint naming a symbol, file, or behaviour to investigate. */
  hint: string;
  /** Optional repository scope. */
  repo?: string;
  /** Optional git ref or range (e.g. `v1.2.0` or `abc123..HEAD`) to bound history. */
  since?: string;
  /**
   * Optional runtime-log window as a duration (e.g. `30d`, `24h`), independent of `since`.
   * `since` is git-shaped (refs/ranges) and falls back to the 7-day default for logs; set
   * this to look further back for the actual error signatures.
   */
  logsSince?: string;
  /** Optional service name scope. */
  service?: string;
  /**
   * Optional path scope (e.g. `packages/core` or `apps/api`) — resolve the seed only from
   * symbols whose file is under this directory. Lets a backend hint avoid seeding a co-located
   * frontend in a monorepo (HOR-356).
   */
  scope?: string;
}

/** A deterministic, evidence-backed finding asserted by the engine. */
export interface ReportFinding {
  /** Coarse classification, e.g. 'observation' | 'anomaly' | 'correlation'. */
  kind: string;
  title: string;
  detail?: string;
  /** 0–1 confidence in the assertion. */
  confidence: number;
  /** Ids of the Evidence rows this finding draws from. */
  evidenceIds: string[];
}

/** The full investigation report — also the persisted shape. */
export interface InvestigationReport {
  id: string;
  /**
   * False when the investigation-store DB was unreachable and the report could not
   * be saved — the run is display-only and `horus ask <id>` will not resolve it.
   * Undefined on reports that predate this flag. (HOR-319 DB-resilience.)
   */
  persisted?: boolean;
  input: InvestigationInput;
  summary: string;
  /** Symbols that the hint resolved to. */
  seeds: Symbol[];
  evidence: Evidence[];
  timeline: Timeline;
  correlation: CorrelationResult;
  findings: ReportFinding[];
  /** Ranked cause candidates produced by the Cause Scoring Engine (HOR-15). */
  suspectedCauses: CauseCandidate[];
  hypotheses: ValidatedHypothesis[];
  /** Similar past incidents recalled from institutional memory (context only). */
  similarIncidents: SimilarIncident[];
  /** Structured analysis of what evidence is absent and its confidence impact (HOR-19). */
  gapAnalysis: GapAnalysis;
  /**
   * Infrastructure topology derived from evidence: queues, services, workers,
   * collections, deployments, and the relationships between them (HOR-14).
   */
  graph: InvestigationGraph;
  /** 0–1 overall confidence in the investigation. */
  confidence: number;
  /**
   * Set when the investigation ran WITHOUT source intelligence (HOR-319 layer-2): the
   * code host was unreachable and could not be self-healed, so only runtime evidence
   * (logs/metrics/state/queues) was available. Confidence is capped and structural
   * findings (seed, blast-radius, flows, ownership) are absent. Undefined = full run.
   */
  degraded?: { sourceIntelligence: boolean; reason: string };
  nextActions: string[];
  /** Ownership estimate for the implicated component (HOR-40). Null when repoPath is not supplied. */
  ownership?: OwnershipEstimate | null;
  /** Per-source runtime contribution summary (HOR-70). */
  sourceStatus?: RuntimeSourceReport;
  /** Bounded git change summary collected near the incident window (HOR-94). */
  recentChanges?: BoundedGitChange;
  /**
   * Ordered causal chains derived from validated hypotheses and the evidence graph (HOR-196).
   * Each chain shows trigger → propagation → symptom steps with cited evidence IDs.
   * Present only for hypotheses with verdict 'supported' or 'weakened'.
   */
  causeChains?: CauseChain[];
  /**
   * Persisted AI judgment stored alongside the deterministic report (HOR-198).
   * Present only when --ai was used and the provider succeeded.
   * Deterministic scoring remains authoritative; this field is an annotation only.
   */
  aiJudgment?: StoredAIJudgment;
  /**
   * Gap #5 — when the hint reads as a behavioral "how does X work" question, the report
   * leads with this flow walkthrough instead of the incident pipeline (seeds/causes/
   * confidence). Present only for explanatory hints.
   */
  behavioral?: BehavioralWalkthrough;
}

/**
 * A "how does X work" behavioral walkthrough — the call flow of a code path, built from
 * the seed's pre-computed execution Flow plus its callees. Rendered instead of the
 * incident sections when the hint is explanatory.
 */
export interface BehavioralWalkthrough {
  /** The behavioral question (the hint). */
  question: string;
  /** The flow entry point (controller/resolver/route/handler), or the seed. */
  entry: Symbol | null;
  /** The ordered execution steps (the Flow's steps, or the seed + its callees). */
  steps: Symbol[];
  /** Detected external calls — HTTP clients, queues, webhooks. */
  externalCalls: string[];
  /** Detected persistence — DB/ORM writes, collections. */
  persistence: string[];
  /** Rendered prose walkthrough. */
  narrative: string;
}

/**
 * AI judgment persisted as part of the investigation report (HOR-198).
 * Mirrors NarrativeOutput from @horus/ai but defined here so @horus/engine
 * stays decoupled from @horus/ai.
 */
export interface StoredAIJudgment {
  what: string;
  why: string;
  whereNext: string[];
  citations: Array<{ evidenceId: string; rationale?: string }>;
  confidence: number;
  mentionedServices?: string[];
  hypothesisJudgments?: Array<{
    hypothesisId: string;
    category: string;
    verdict: 'supported' | 'weakened' | 'eliminated' | 'unconfirmed';
    rationale: string;
    citedEvidenceIds: string[];
    confidence: number;
  }>;
  rootCauseAssessment?: {
    summary: string;
    primaryHypothesisId?: string;
    citedEvidenceIds: string[];
    uncertainty: 'low' | 'medium' | 'high';
  };
  /** AI provider name (e.g. 'anthropic') or 'deterministic' for fallback. */
  provider: string;
  /** ISO 8601 timestamp when the judgment was generated. */
  generatedAt: string;
}

/** Re-exported for convenience so callers can type flow steps without @horus/core. */
export type { Evidence, Symbol, Flow };
