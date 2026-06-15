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

export type { CauseCandidate };

/** The user-supplied incident hint plus optional scoping. */
export interface InvestigationInput {
  /** Free-text hint naming a symbol, file, or behaviour to investigate. */
  hint: string;
  /** Optional repository scope. */
  repo?: string;
  /** Optional git ref or range (e.g. `v1.2.0` or `abc123..HEAD`) to bound history. */
  since?: string;
  /** Optional service name scope. */
  service?: string;
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
  nextActions: string[];
  /** Ownership estimate for the implicated component (HOR-40). Null when repoPath is not supplied. */
  ownership?: OwnershipEstimate | null;
  /** Per-source runtime contribution summary (HOR-70). */
  sourceStatus?: RuntimeSourceReport;
  /** Bounded git change summary collected near the incident window (HOR-94). */
  recentChanges?: BoundedGitChange;
}

/** Re-exported for convenience so callers can type flow steps without @horus/core. */
export type { Evidence, Symbol, Flow };
