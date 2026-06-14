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
