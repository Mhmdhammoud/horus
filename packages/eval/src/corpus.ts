/**
 * Corpus construction (HOR-403) — the read-only transform from outcome labels + joined reports to a
 * stable, evaluable corpus. Pure: it takes already-fetched labels and a report resolver, so it is
 * trivially testable and shares the EXACT current-verdict definition with `horus memory accuracy`.
 *
 * Pipeline (each stage counted, never silently dropped):
 *   1. dedupe to the CURRENT verdict per investigation (shared `dedupeToCurrentVerdict`);
 *   2. drop null-investigationId verdicts → `unjoinable` (the label has no report to join);
 *   3. validate-on-read firewall: resolved∈{yes,partly,no} + source∈{feedback,confirm} → else
 *      `quarantine`;
 *   4. join `investigations.report` by investigationId → missing/legacy report → `unjoinable`;
 *   5. project the survivors into `CorpusRow`s (confirm rows flagged weak + confirmedCause dropped).
 */
import {
  dedupeToCurrentVerdict,
  isOutcomeResolved,
  isOutcomeSource,
  type OutcomeLabel,
} from '@horus/db';
import type { CauseCandidate, InvestigationReport } from '@horus/engine';
import {
  CORPUS_VERSION,
  type CorpusArtifact,
  type CorpusBuild,
  type CorpusFactor,
  type CorpusHeadlineCause,
  type CorpusManifest,
  type CorpusRow,
  type HoldoutSplit,
  type QuarantinedRow,
  type UnjoinableRow,
} from './types.js';

/** Resolves an investigation's stored report blob (jsonb) by id, or null when absent. */
export type ReportResolver = (investigationId: string) => unknown;

/** A minimally-validated report view: enough to be a corpus row (defensive against legacy blobs). */
interface UsableReport {
  summary: string;
  confidence: number;
  seeds: string[];
  causes: CauseCandidate[];
}

/**
 * Validate a stored report blob into a `UsableReport`, or null if it is missing/legacy. "Legacy" =
 * not an object or no `suspectedCauses` array (the field that carries every cause-scoring feature).
 * An empty `suspectedCauses` is VALID (the run ranked nothing) — it joins with headlineCause=null.
 */
function toUsableReport(blob: unknown): UsableReport | null {
  if (blob === null || typeof blob !== 'object') return null;
  const r = blob as Partial<InvestigationReport>;
  if (!Array.isArray(r.suspectedCauses)) return null;
  const seeds = Array.isArray(r.seeds)
    ? r.seeds.map((s) => (s && typeof s === 'object' && 'name' in s ? String(s.name) : '')).filter(Boolean)
    : [];
  return {
    summary: typeof r.summary === 'string' ? r.summary : '',
    confidence: typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 0,
    seeds,
    causes: r.suspectedCauses as CauseCandidate[],
  };
}

/**
 * Pick the headline cause: the one Horus pointed at — highest `finalScore`, tie-broken by `id` asc
 * for determinism. Returns null when no causes were ranked.
 */
export function pickHeadlineCause(causes: readonly CauseCandidate[]): CauseCandidate | null {
  let best: CauseCandidate | null = null;
  for (const c of causes) {
    if (
      best === null ||
      c.finalScore > best.finalScore ||
      (c.finalScore === best.finalScore && c.id < best.id)
    ) {
      best = c;
    }
  }
  return best;
}

/** Flatten a cause's explanations into factor→summed-delta, sorted by factor for byte-stability. */
function flattenFactors(cause: CauseCandidate): CorpusFactor[] {
  const sums = new Map<string, number>();
  for (const e of cause.explanations ?? []) {
    sums.set(e.factor, (sums.get(e.factor) ?? 0) + e.delta);
  }
  return [...sums.entries()]
    .map(([factor, delta]) => ({ factor, delta }))
    .sort((a, b) => (a.factor < b.factor ? -1 : a.factor > b.factor ? 1 : 0));
}

function projectHeadline(cause: CauseCandidate): CorpusHeadlineCause {
  return {
    id: cause.id,
    category: cause.category,
    finalScore: cause.finalScore,
    confidence: cause.confidence,
    band: cause.band,
    sourceEvidenceIds: [...(cause.sourceEvidenceIds ?? [])].sort(),
    factors: flattenFactors(cause),
  };
}

/**
 * Build the corpus from a label set + a report resolver. READ-ONLY: nothing here writes. The labels
 * are expected pre-filtered (project/source/since/limit) by the caller, exactly as
 * `horus memory accuracy` filters them, so the two read paths stay aligned.
 */
export function buildCorpus(labels: readonly OutcomeLabel[], resolveReport: ReportResolver): CorpusBuild {
  const current = dedupeToCurrentVerdict(labels);
  const evaluated = current.length;

  const rows: CorpusRow[] = [];
  const quarantined: QuarantinedRow[] = [];
  const unjoinable: UnjoinableRow[] = [];

  for (const label of current) {
    // (2) A null investigationId carries no report to join — the label has only `project`.
    if (label.investigationId === null) {
      unjoinable.push({ investigationId: null, reason: 'null-investigation' });
      continue;
    }
    // (3) Validate-on-read firewall: defense-in-depth against legacy/corrupt rows.
    if (!isOutcomeResolved(label.resolved) || !isOutcomeSource(label.source)) {
      quarantined.push({
        investigationId: label.investigationId,
        resolved: String(label.resolved),
        source: String(label.source),
        reason: !isOutcomeResolved(label.resolved)
          ? `invalid resolved "${String(label.resolved)}"`
          : `invalid source "${String(label.source)}"`,
      });
      continue;
    }
    // (4) Join the report.
    const blob = resolveReport(label.investigationId);
    if (blob === null || blob === undefined) {
      unjoinable.push({ investigationId: label.investigationId, reason: 'missing-report' });
      continue;
    }
    const report = toUsableReport(blob);
    if (report === null) {
      unjoinable.push({ investigationId: label.investigationId, reason: 'legacy-report' });
      continue;
    }
    // (5) Project to a corpus row. confirm = positive-only/weak; its confirmedCause is circular.
    const isConfirm = label.source === 'confirm';
    const headline = pickHeadlineCause(report.causes);
    rows.push({
      investigationId: label.investigationId,
      project: label.project,
      at: label.at instanceof Date ? label.at.toISOString() : String(label.at),
      target: label.resolved,
      source: label.source,
      weak: isConfirm,
      confirmedCause: isConfirm ? null : (label.confirmedCause ?? null),
      summary: report.summary,
      reportConfidence: report.confidence,
      seeds: report.seeds,
      causeCount: report.causes.length,
      headlineCause: headline ? projectHeadline(headline) : null,
    });
  }

  const classBalance = { yes: 0, partly: 0, no: 0 };
  const bySource = { feedback: 0, confirm: 0 };
  for (const r of rows) {
    classBalance[r.target] += 1;
    bySource[r.source] += 1;
  }

  return { rows, evaluated, quarantined, unjoinable, classBalance, bySource };
}

/** `corpus-<version>.jsonl`. */
export function corpusFilename(version: string = CORPUS_VERSION): string {
  return `corpus-${version}.jsonl`;
}

/**
 * Sort corpus rows for byte-stable output: by investigationId, then by `at`. Identical inputs always
 * produce an identical ordering (and JSON.stringify of a fixed-shape object is key-stable here).
 */
function sortRows(rows: readonly CorpusRow[]): CorpusRow[] {
  return [...rows].sort((a, b) => {
    if (a.investigationId !== b.investigationId) return a.investigationId < b.investigationId ? -1 : 1;
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return 0;
  });
}

/**
 * Deterministic FNV-1a (32-bit) string hash — used only to bucket investigationIds into the holdout
 * split. No crypto dependency; stable across runs/machines.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic holdout split spec: `hash(investigationId) % 100 < holdoutPct` → holdout, else
 * train. Stable and reproducible — the same investigation always lands in the same bucket.
 */
export function holdoutSplit(
  rows: readonly { investigationId: string }[],
  holdoutPct = 20,
): HoldoutSplit {
  const train: string[] = [];
  const holdout: string[] = [];
  for (const r of rows) {
    if (fnv1a(r.investigationId) % 100 < holdoutPct) holdout.push(r.investigationId);
    else train.push(r.investigationId);
  }
  train.sort();
  holdout.sort();
  return { holdoutPct, train, holdout };
}

/**
 * Serialize a corpus build into a byte-stable artifact: a sorted JSONL body + a manifest. For
 * identical inputs the `jsonl` is byte-identical (sorted rows, fixed key order). `generatedAt` is
 * left null here so the body and manifest stay deterministic; the writer stamps it.
 */
export function serializeCorpus(build: CorpusBuild, version: string = CORPUS_VERSION): CorpusArtifact {
  const sorted = sortRows(build.rows);
  const jsonl = sorted.map((r) => JSON.stringify(r)).join('\n') + (sorted.length > 0 ? '\n' : '');
  const manifest: CorpusManifest = {
    version,
    generatedAt: null,
    rows: sorted.length,
    evaluated: build.evaluated,
    quarantined: build.quarantined.length,
    unjoinable: build.unjoinable.length,
    classBalance: build.classBalance,
    bySource: build.bySource,
    holdout: holdoutSplit(sorted),
  };
  return { filename: corpusFilename(version), jsonl, manifest };
}
