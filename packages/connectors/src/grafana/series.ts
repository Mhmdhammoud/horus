/**
 * Pure normalization helpers for metric series data (HOR-11 reframe).
 * No I/O — all functions are exhaustively unit-testable.
 * Relocated from prometheus/normalize.ts.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface MetricSample {
  /** Unix timestamp in seconds. */
  t: number;
  /** Numeric value (may be NaN or Infinity for special Prometheus values). */
  v: number;
}

export interface MetricSeries {
  labels: Record<string, string>;
  samples: MetricSample[];
}

export interface SeriesSummary {
  labels: Record<string, string>;
  min: number;
  max: number;
  avg: number;
  last: number;
  count: number;
}

export interface BaselineComparison {
  labels: Record<string, string>;
  baselineAvg: number;
  currentAvg: number;
  delta: number;
  ratio: number;
  isSpike: boolean;
}

export interface SpikePoint {
  t: number;
  v: number;
  mean: number;
  std: number;
  z: number;
}

export interface Quartiles {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  /** Inter-quartile range (q3 - q1). */
  iqr: number;
}

export interface HistogramBin {
  /** Inclusive lower bound. */
  lo: number;
  /** Exclusive upper bound (inclusive for the final bin). */
  hi: number;
  count: number;
}

/**
 * Result of the bimodal (two-population) detection over a panel's series comparisons.
 * `bimodal` is true only when a HIGH-spike population AND a LOW/zero/empty population
 * are BOTH co-present with a real share — never for a lone outlier.
 */
export interface BimodalResult {
  bimodal: boolean;
  total: number;
  highCount: number;
  /** Genuine low/zero (finite, ≤ drop) members. */
  lowCount: number;
  /** Non-finite / empty (Infinity / NaN) members — the "empty run". */
  degenerateCount: number;
  highShare: number;
  /** Share of the counter-population (low + degenerate) over the total. */
  lowShare: number;
  /** Median ratio of the high population (for the human label). */
  highRatio: number;
  /** Median ratio of the genuine-low population (NaN when none). */
  lowRatio: number;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Prometheus string value into a JS number.
 * Special values: "NaN" -> NaN, "+Inf" -> Infinity, "-Inf" -> -Infinity.
 */
export function parseValue(raw: string): number {
  if (raw === 'NaN') return NaN;
  if (raw === '+Inf') return Infinity;
  if (raw === '-Inf') return -Infinity;
  return Number(raw);
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

/**
 * Parse a Prometheus instant query response (resultType: "vector").
 * Each result element has { metric: {...}, value: [timestamp, "stringVal"] }.
 */
export function parseInstant(resp: unknown): MetricSeries[] {
  const r = resp as Record<string, unknown>;
  const data = r['data'] as Record<string, unknown> | undefined;
  if (data === undefined) return [];

  const result = data['result'];
  if (!Array.isArray(result)) return [];

  return result.map((item: unknown): MetricSeries => {
    const it = item as Record<string, unknown>;
    const labels = (it['metric'] ?? {}) as Record<string, string>;
    const value = it['value'];
    if (!Array.isArray(value) || value.length < 2) {
      return { labels, samples: [] };
    }
    const t = typeof value[0] === 'number' ? value[0] : Number(value[0]);
    const v = parseValue(String(value[1]));
    return { labels, samples: [{ t, v }] };
  });
}

/**
 * Parse a Prometheus range query response (resultType: "matrix").
 * Each result element has { metric: {...}, values: [[timestamp, "str"], ...] }.
 */
export function parseRange(resp: unknown): MetricSeries[] {
  const r = resp as Record<string, unknown>;
  const data = r['data'] as Record<string, unknown> | undefined;
  if (data === undefined) return [];

  const result = data['result'];
  if (!Array.isArray(result)) return [];

  return result.map((item: unknown): MetricSeries => {
    const it = item as Record<string, unknown>;
    const labels = (it['metric'] ?? {}) as Record<string, string>;
    const values = it['values'];
    if (!Array.isArray(values)) {
      return { labels, samples: [] };
    }
    const samples: MetricSample[] = values.map((pair: unknown): MetricSample => {
      const p = pair as unknown[];
      const t = typeof p[0] === 'number' ? p[0] : Number(p[0]);
      const v = parseValue(String(p[1] ?? 'NaN'));
      return { t, v };
    });
    return { labels, samples };
  });
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/** Compute min/max/avg/last/count over a series' samples, ignoring NaN values. */
export function summarize(series: MetricSeries): SeriesSummary {
  const finite = series.samples.filter((s) => !Number.isNaN(s.v));
  if (finite.length === 0) {
    return { labels: series.labels, min: 0, max: 0, avg: 0, last: 0, count: 0 };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const s of finite) {
    if (s.v < min) min = s.v;
    if (s.v > max) max = s.v;
    sum += s.v;
  }
  const avg = sum / finite.length;
  // last is the sample with the greatest timestamp among finite values
  const lastSample = finite.reduce((a, b) => (a.t >= b.t ? a : b));

  return {
    labels: series.labels,
    min,
    max,
    avg,
    last: lastSample.v,
    count: finite.length,
  };
}

/**
 * Build a stable string key for a label set (for joining baseline vs current).
 */
function labelKey(labels: Record<string, string>): string {
  const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(sorted);
}

/**
 * Compare two windows of metric series (baseline vs current).
 * Returns one `BaselineComparison` per series present in `current`, sorted by delta desc.
 * `spikeRatio` defaults to 1.5.
 */
export function compareWindows(
  baseline: MetricSeries[],
  current: MetricSeries[],
  spikeRatio = 1.5,
): BaselineComparison[] {
  const baselineMap = new Map<string, MetricSeries>();
  for (const s of baseline) {
    baselineMap.set(labelKey(s.labels), s);
  }

  const comparisons: BaselineComparison[] = current.map((cs): BaselineComparison => {
    const key = labelKey(cs.labels);
    const bs = baselineMap.get(key);
    const baselineAvg = bs !== undefined ? summarize(bs).avg : 0;
    const currentAvg = summarize(cs).avg;
    const delta = currentAvg - baselineAvg;
    const ratio =
      baselineAvg === 0
        ? currentAvg > 0
          ? Infinity
          : 0
        : currentAvg / baselineAvg;
    const isSpike = ratio >= spikeRatio;
    return { labels: cs.labels, baselineAvg, currentAvg, delta, ratio, isSpike };
  });

  comparisons.sort((a, b) => b.delta - a.delta);
  return comparisons;
}

/**
 * Detect spike points in a single series using z-score thresholding.
 *
 * The series mean/std (population) are reported on each spike point, but the spike
 * z-score for a sample is computed against the *leave-one-out* mean (the mean of the
 * other samples) so that a single large outlier does not dilute its own baseline and
 * suppress its own z-score. Returns points whose leave-one-out z-score exceeds `k`
 * (requires std > 0 and at least 2 finite samples).
 */
export function detectSpikes(series: MetricSeries, k = 3): SpikePoint[] {
  const finite = series.samples.filter((s) => !Number.isNaN(s.v) && Number.isFinite(s.v));
  const n = finite.length;
  if (n < 2) return [];

  const sum = finite.reduce((acc, s) => acc + s.v, 0);
  const mean = sum / n;
  const variance = finite.reduce((acc, s) => acc + (s.v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);

  if (std === 0) return [];

  const spikes: SpikePoint[] = [];
  for (const s of finite) {
    const meanOthers = (sum - s.v) / (n - 1);
    const z = (s.v - meanOthers) / std;
    if (z > k) {
      spikes.push({ t: s.t, v: s.v, mean, std, z });
    }
  }
  return spikes;
}

// ---------------------------------------------------------------------------
// Distribution helpers (HOR-435 — bimodal detection support)
// ---------------------------------------------------------------------------

/** Linear-interpolated percentile over an ascending-sorted finite array. `p` in [0,1]. */
function quantileSorted(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0]!;
  const pos = (n - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = pos - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/**
 * Five-number summary (min/q1/median/q3/max + IQR) over finite values. Returns null
 * when there are no finite values. Pure — used for spread characterization.
 */
export function quartiles(values: number[]): Quartiles | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  return {
    min: sorted[0]!,
    q1,
    median: quantileSorted(sorted, 0.5),
    q3,
    max: sorted[sorted.length - 1]!,
    iqr: q3 - q1,
  };
}

/**
 * Equal-width histogram over finite values with `bins` buckets (default 10). Returns
 * [] when there are no finite values. A degenerate range (all equal) yields a single
 * populated bin. Pure — supports two-population / gap analysis.
 */
export function histogram(values: number[], bins = 10): HistogramBin[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [];
  const count = Math.max(1, Math.floor(bins));
  let min = Infinity;
  let max = -Infinity;
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return [{ lo: min, hi: max, count: finite.length }];
  }
  const width = (max - min) / count;
  const out: HistogramBin[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ lo: min + i * width, hi: min + (i + 1) * width, count: 0 });
  }
  for (const v of finite) {
    let idx = Math.floor((v - min) / width);
    if (idx >= count) idx = count - 1; // the max lands in the final bin
    if (idx < 0) idx = 0;
    out[idx]!.count += 1;
  }
  return out;
}

/** Median of a finite array (NaN when empty). */
function median(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return NaN;
  const sorted = [...finite].sort((a, b) => a - b);
  return quantileSorted(sorted, 0.5);
}

/**
 * Detect a BIMODAL (two-population) pattern across a panel's series comparisons.
 *
 * Today each series is classified independently, so a panel where one segment spikes
 * 3.3× while another drops to 0.5× and a third is empty/Infinity reads as several
 * unrelated "latency-spike" / "under load" findings — overstating a uniform regression.
 * The truth is heterogeneity: distinct sub-populations behaving differently (per-segment
 * variance). This detects that co-presence so the engine can de-anchor.
 *
 * A pattern is bimodal only when BOTH a HIGH-spike population (finite ratio ≥ spike)
 * AND a counter-population (genuine low ratio ≤ drop, OR an empty/Infinity/NaN run) are
 * co-present, the counter-population holds a REAL share (≥ minShare AND ≥ minMinority
 * members — so a lone outlier never trips it), and there is a real gap between the two
 * clusters (high-median ≥ gapFactor × the high threshold over the low cluster). This is
 * conservative by design: it makes the engine MORE honest, never less.
 */
export function detectBimodalPopulation(
  comparisons: BaselineComparison[],
  opts?: {
    spike?: number;
    drop?: number;
    minShare?: number;
    minMinority?: number;
    minTotal?: number;
    gapFactor?: number;
  },
): BimodalResult {
  const spike = opts?.spike ?? 1.5;
  const drop = opts?.drop ?? 0.67;
  const minShare = opts?.minShare ?? 0.2;
  const minMinority = opts?.minMinority ?? 2;
  const minTotal = opts?.minTotal ?? 3;
  const gapFactor = opts?.gapFactor ?? 2;

  const total = comparisons.length;
  const empty: BimodalResult = {
    bimodal: false,
    total,
    highCount: 0,
    lowCount: 0,
    degenerateCount: 0,
    highShare: 0,
    lowShare: 0,
    highRatio: NaN,
    lowRatio: NaN,
  };

  const highRatios: number[] = [];
  const lowRatios: number[] = [];
  let degenerateCount = 0;

  for (const c of comparisons) {
    const r = c.ratio;
    if (!Number.isFinite(r)) {
      // Infinity / NaN — an "empty run" or a no-baseline division. Counter-population.
      degenerateCount += 1;
    } else if (r >= spike) {
      highRatios.push(r);
    } else if (r > 0 && r <= drop) {
      lowRatios.push(r);
    } else if (r === 0) {
      // A true zero (empty/no current) — counts toward the low/empty population.
      degenerateCount += 1;
    }
    // ratios in (drop, spike) are the "stable / normal" middle and are ignored here.
  }

  const highCount = highRatios.length;
  const lowCount = lowRatios.length;
  const counterCount = lowCount + degenerateCount;

  const result: BimodalResult = {
    ...empty,
    highCount,
    lowCount,
    degenerateCount,
    highShare: total > 0 ? highCount / total : 0,
    lowShare: total > 0 ? counterCount / total : 0,
    highRatio: median(highRatios),
    lowRatio: median(lowRatios),
  };

  if (total < minTotal) return result;
  // Both populations must be present.
  if (highCount < 1 || counterCount < 1) return result;
  // The COUNTER-population must hold a real share — never trip on a lone outlier.
  if (counterCount < minMinority) return result;
  if (result.lowShare < minShare) return result;
  // And a meaningful HIGH share too (a real spike cluster, not a single straggler).
  if (highCount < minMinority && result.highShare < minShare) return result;
  // Require a genuine gap between the clusters when a finite low cluster exists.
  if (lowCount > 0) {
    const hi = result.highRatio;
    const lo = result.lowRatio;
    if (Number.isFinite(hi) && Number.isFinite(lo) && lo > 0 && hi / lo < gapFactor) {
      return result;
    }
  }

  result.bimodal = true;
  return result;
}
