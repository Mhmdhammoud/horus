/**
 * Public types for the read-only accuracy harness (HOR-403).
 *
 * The harness turns the converged outcome-label store (HOR-390) + the joined investigation reports
 * into a stable, evaluable corpus + a baseline accuracy report + a no-model feature-separation
 * diagnostic. It NEVER writes the label store — only `horus feedback` (source=feedback) and
 * `horus memory confirm` (source=confirm) do. Everything here is a read/transform.
 */
import type { OutcomeResolved, OutcomeSource } from '@horus/db';

/** Schema version of the emitted corpus — bump when the row shape changes. */
export const CORPUS_VERSION = 'v1' as const;

/** One factor's contribution on the headline cause, flattened from `ScoreExplanation`. */
export interface CorpusFactor {
  /** Stable factor id, e.g. 'evidence-quality'. */
  factor: string;
  /** Summed signed delta for this factor on the headline cause. */
  delta: number;
}

/** The headline cause Horus pointed at (highest finalScore, tie-broken by id) projected for eval. */
export interface CorpusHeadlineCause {
  id: string;
  category: string;
  finalScore: number;
  confidence: number;
  band: string;
  sourceEvidenceIds: string[];
  /** Flattened, factor-sorted explanation deltas (deterministic order). */
  factors: CorpusFactor[];
}

/**
 * One corpus row = one investigation's CURRENT verdict joined to its report's cause-scoring features.
 *
 * The `target` is the human verdict (yes|partly|no). For `confirm` rows the target is positive-only
 * and weak (confirm hard-codes resolved=yes), and `confirmedCause` is deliberately DROPPED to null —
 * confirm's confirmedCause is Horus's own report.summary, so using it as a target is circular.
 */
export interface CorpusRow {
  investigationId: string;
  project: string | null;
  /** ISO-8601 attestation time of the current verdict. */
  at: string;
  /** The label verdict — the supervised target. */
  target: OutcomeResolved;
  source: OutcomeSource;
  /** True for source=confirm: positive-only + weak (never a discriminative target). */
  weak: boolean;
  /** Human-attested root cause — feedback only; null for confirm (circular) and when absent. */
  confirmedCause: string | null;
  /** Report headline summary (Horus's own one-liner). */
  summary: string;
  /** 0–1 overall investigation confidence from the report. */
  reportConfidence: number;
  /** Seed symbol names the hint resolved to (minimal projection). */
  seeds: string[];
  /** Number of suspected causes the report ranked. */
  causeCount: number;
  /** The headline (top-ranked) cause, or null when the report ranked none. */
  headlineCause: CorpusHeadlineCause | null;
}

/** A row that failed the validate-on-read firewall (bad resolved/source) — counted, excluded. */
export interface QuarantinedRow {
  investigationId: string | null;
  resolved: string;
  source: string;
  reason: string;
}

/** A current-verdict row that could not be joined to a usable report — counted, excluded. */
export interface UnjoinableRow {
  investigationId: string | null;
  reason: 'null-investigation' | 'missing-report' | 'legacy-report';
}

/** Class balance over the corpus targets (current verdicts that survived to the corpus). */
export interface ClassBalance {
  yes: number;
  partly: number;
  no: number;
}

/** Source segregation count over the corpus rows. */
export interface SourceBalance {
  feedback: number;
  confirm: number;
}

/** Result of building the corpus from the labels + report resolver (all read-only, pure). */
export interface CorpusBuild {
  rows: CorpusRow[];
  /** Distinct investigations carrying a current verdict (before firewall/join drops). */
  evaluated: number;
  /** Firewall rejects — bad resolved/source. Counted, excluded from `rows`. */
  quarantined: QuarantinedRow[];
  /** Join failures — null investigationId or missing/legacy report. Counted, excluded. */
  unjoinable: UnjoinableRow[];
  classBalance: ClassBalance;
  bySource: SourceBalance;
}

/** Deterministic, byte-stable serialization of a corpus build. */
export interface CorpusArtifact {
  /** `corpus-<version>.jsonl` filename. */
  filename: string;
  /** The JSONL body (one CorpusRow per line, trailing newline), sorted deterministically. */
  jsonl: string;
  manifest: CorpusManifest;
}

/** Sidecar manifest describing a corpus artifact. */
export interface CorpusManifest {
  version: string;
  /** Set by the writer; not part of the deterministic jsonl. */
  generatedAt: string | null;
  rows: number;
  evaluated: number;
  quarantined: number;
  unjoinable: number;
  classBalance: ClassBalance;
  bySource: SourceBalance;
  holdout: HoldoutSplit;
}

/** Deterministic 80/20 holdout split spec — partitions investigationIds by a stable hash. */
export interface HoldoutSplit {
  /** Holdout fraction (0–1); the rule is `hash(investigationId) % 100 < holdoutPct`. */
  holdoutPct: number;
  /** investigationIds assigned to training (sorted). */
  train: string[];
  /** investigationIds assigned to the held-out eval set (sorted). */
  holdout: string[];
}

/** Per-project hit-rate slice, same math as `summarizeOutcomeLabels`. */
export interface ProjectBaseline {
  project: string | null;
  n: number;
  strictHitRate: number;
  weightedHitRate: number;
}

/**
 * The baseline accuracy report — Horus's own measured hit-rate over the eval set, computed with the
 * SAME math as `summarizeOutcomeLabels` so it can never drift from `horus memory accuracy`.
 */
export interface BaselineReport {
  /** Distinct investigations with a current verdict. */
  n: number;
  /** `yes / n` — strict "did it point at the cause?". */
  strictHitRate: number;
  /** `(yes + 0.5·partly) / n` — partial-credit. */
  weightedHitRate: number;
  classBalance: ClassBalance;
  bySource: SourceBalance;
  byProject: ProjectBaseline[];
}

/**
 * One factor's yes-vs-no separation across the corpus — a NO-MODEL diagnostic. We measure how far
 * apart the factor's delta sits between yes-outcome and no-outcome rows, plus a simple
 * variance/effect-size estimate. `confirm` rows are excluded (positive-only → no `no` samples).
 */
export interface FeatureSeparation {
  factor: string;
  nYes: number;
  nNo: number;
  meanYes: number;
  meanNo: number;
  varYes: number;
  varNo: number;
  /** meanYes − meanNo. */
  separation: number;
  /** separation / pooled-std (0 when pooled-std is 0); a Cohen's-d-ish signal-to-noise. */
  effectSize: number;
  /** Coefficient of variation of the factor overall (pooled-std / |overall-mean|). */
  cv: number;
}

/** The feature-separation diagnostic over all factors (sorted by |effectSize| desc, then factor). */
export interface FeatureSeparationReport {
  /** Rows used (feedback rows with a headline cause and a yes/no target). */
  evaluated: number;
  factors: FeatureSeparation[];
}

/** Read-flag slice shared with `horus memory accuracy` (--source/--days/--limit/--repo). */
export interface EvalReadOptions {
  source?: OutcomeSource;
  /** Inclusive lower bound on `at`. */
  since?: Date;
  limit?: number;
}
