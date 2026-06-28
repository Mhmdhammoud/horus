/**
 * Baseline accuracy + feature-separation diagnostic (HOR-403).
 *
 * `computeBaseline` is intentionally a thin shell over `summarizeOutcomeLabels` so the harness's
 * hit-rate can NEVER drift from `horus memory accuracy`: same dedupe, same math. `featureSeparation`
 * is a NO-MODEL diagnostic — it only measures how far each cause-scoring factor's delta separates
 * yes-outcome from no-outcome rows, with a simple variance/effect-size estimate. Nothing is trained.
 */
import { summarizeOutcomeLabels, type OutcomeLabel } from '@horus/db';
import type {
  BaselineReport,
  CorpusRow,
  FeatureSeparation,
  FeatureSeparationReport,
  ProjectBaseline,
} from './types.js';

/**
 * Compute the baseline hit-rate report over a label set with the SAME math as
 * `summarizeOutcomeLabels` (so it equals `horus memory accuracy`). `byProject` partitions the labels
 * by `project` and summarizes each slice with the identical function.
 */
export function computeBaseline(labels: readonly OutcomeLabel[]): BaselineReport {
  const summary = summarizeOutcomeLabels(labels);

  const byProjectMap = new Map<string | null, OutcomeLabel[]>();
  for (const l of labels) {
    const key = l.project ?? null;
    const arr = byProjectMap.get(key);
    if (arr) arr.push(l);
    else byProjectMap.set(key, [l]);
  }
  const byProject: ProjectBaseline[] = [...byProjectMap.entries()]
    .map(([project, slice]) => {
      const s = summarizeOutcomeLabels(slice);
      return {
        project,
        n: s.evaluated,
        strictHitRate: s.accuracy,
        weightedHitRate: s.weightedScore,
      };
    })
    .sort((a, b) => {
      // Stable: nulls last, then by project name.
      if (a.project === b.project) return 0;
      if (a.project === null) return 1;
      if (b.project === null) return -1;
      return a.project < b.project ? -1 : 1;
    });

  return {
    n: summary.evaluated,
    strictHitRate: summary.accuracy,
    weightedHitRate: summary.weightedScore,
    classBalance: summary.counts,
    bySource: summary.bySource,
    byProject,
  };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population variance (divide by n) — a simple, deterministic spread estimate. */
function variance(xs: readonly number[], m: number): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
}

/**
 * Feature-separation diagnostic. For each factor seen on any headline cause, gather its delta on the
 * yes-outcome rows vs the no-outcome rows and report mean/variance/separation/effect-size + an
 * overall CV. `confirm` rows are excluded (positive-only → no `no` samples, and circular target).
 * `partly` rows are excluded from the two-group contrast (the diagnostic is strictly yes-vs-no).
 *
 * A row that lacks a factor contributes a 0 delta for that factor (the factor did not fire), which
 * is the correct neutral baseline for separation.
 */
export function featureSeparation(rows: readonly CorpusRow[]): FeatureSeparationReport {
  // Only feedback rows with a headline cause and a yes/no target are usable.
  const usable = rows.filter(
    (r) => !r.weak && r.headlineCause !== null && (r.target === 'yes' || r.target === 'no'),
  );

  // Discover every factor across usable rows (deterministic, sorted).
  const factorSet = new Set<string>();
  for (const r of usable) {
    for (const f of r.headlineCause!.factors) factorSet.add(f.factor);
  }
  const factors = [...factorSet].sort();

  const out: FeatureSeparation[] = factors.map((factor) => {
    const yes: number[] = [];
    const no: number[] = [];
    for (const r of usable) {
      const f = r.headlineCause!.factors.find((x) => x.factor === factor);
      const delta = f ? f.delta : 0; // factor did not fire on this row → neutral 0
      if (r.target === 'yes') yes.push(delta);
      else no.push(delta);
    }
    const meanYes = mean(yes);
    const meanNo = mean(no);
    const varYes = variance(yes, meanYes);
    const varNo = variance(no, meanNo);
    const separation = meanYes - meanNo;

    // Pooled std across both groups for a Cohen's-d-ish effect size.
    const all = yes.concat(no);
    const overallMean = mean(all);
    const pooledVar = variance(all, overallMean);
    const pooledStd = Math.sqrt(pooledVar);
    const effectSize = pooledStd === 0 ? 0 : separation / pooledStd;
    const cv = overallMean === 0 ? 0 : pooledStd / Math.abs(overallMean);

    return {
      factor,
      nYes: yes.length,
      nNo: no.length,
      meanYes,
      meanNo,
      varYes,
      varNo,
      separation,
      effectSize,
      cv,
    };
  });

  out.sort((a, b) => {
    const d = Math.abs(b.effectSize) - Math.abs(a.effectSize);
    if (d !== 0) return d;
    return a.factor < b.factor ? -1 : a.factor > b.factor ? 1 : 0;
  });

  return { evaluated: usable.length, factors: out };
}
