/**
 * Pure analysis layer: compare metric windows, classify anomalies, build Evidence (HOR-11 reframe).
 * No I/O — all functions are unit-testable.
 */

import type { Evidence } from '@horus/core';
import {
  type MetricSeries,
  type BaselineComparison,
  summarize,
  compareWindows,
  detectBimodalPopulation,
} from './series.js';
import type { MetricKind } from './panels.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Anomaly =
  | 'latency-spike'
  | 'error-rate-change'
  | 'throughput-drop'
  | 'queue-growth'
  | 'change'
  /**
   * Two co-present sub-populations on one panel (HOR-435): a high-spike cluster AND a
   * low/zero/empty cluster — possible per-segment variance, NOT a uniform regression.
   * Reclassifies what would otherwise be several independent latency-spike/under-load
   * findings, and carries LOWER relevance to de-anchor the engine's confidence.
   */
  | 'bimodal-population'
  | 'none';

export interface MetricFinding {
  dashboardUid: string;
  panelTitle: string;
  kind: MetricKind;
  anomaly: Anomaly;
  labels: Record<string, string>;
  baselineAvg: number;
  currentAvg: number;
  ratio: number;
  lastValue: number;
  /** Where the hint matched — null when no hint was given or match source is unknown. */
  matchSource?: 'panel-title' | 'query-text' | 'series-labels' | null;
}

// ---------------------------------------------------------------------------
// Anomaly classification
// ---------------------------------------------------------------------------

export function classifyAnomaly(
  kind: MetricKind,
  cmp: BaselineComparison,
  opts?: { spike?: number; drop?: number },
): Anomaly {
  const spike = opts?.spike ?? 1.5;
  const drop = opts?.drop ?? 0.67;

  // HOR-342: a "spike" on a metric with no baseline (baselineAvg ≈ 0) yields an Infinity
  // ratio and is flagged regardless of magnitude — so a no-traffic op going 0 → 0.024s, or
  // a queue depth 0 → 0.03, reads identically to a real 0 → 2.4s spike. Require a meaningful
  // absolute magnitude before flagging a zero-baseline jump, so trivial blips are dropped.
  const NEAR_ZERO = 1e-9;
  if (cmp.baselineAvg <= NEAR_ZERO && cmp.currentAvg > 0) {
    const floor =
      kind === 'queue'
        ? 1 // < 1 job is not a backlog (unit-independent)
        : kind === 'latency'
          ? 0.05 // 50ms p95 (latency series are in seconds on this instance)
          : kind === 'error-rate'
            ? 0.005
            : 0; // throughput is about drops; generic 'change' keeps its own gate
    if (cmp.currentAvg < floor) return 'none';
  }

  if (kind === 'latency' && cmp.ratio >= spike) return 'latency-spike';

  if (
    kind === 'queue' &&
    (cmp.ratio >= spike || cmp.currentAvg > cmp.baselineAvg) &&
    cmp.delta > 0
  ) {
    return 'queue-growth';
  }

  if (kind === 'throughput' && cmp.ratio > 0 && cmp.ratio <= drop) {
    return 'throughput-drop';
  }

  if (kind === 'error-rate' && cmp.ratio >= spike) return 'error-rate-change';

  if (cmp.ratio >= spike || (cmp.ratio > 0 && cmp.ratio <= drop)) return 'change';

  return 'none';
}

// ---------------------------------------------------------------------------
// Finding construction
// ---------------------------------------------------------------------------

/**
 * Compare baseline and current series for a single panel and produce findings.
 * Includes findings with anomaly "none" so callers can show a full summary.
 */
export function buildFindings(
  dashboardUid: string,
  panelTitle: string,
  kind: MetricKind,
  baseline: MetricSeries[],
  current: MetricSeries[],
): MetricFinding[] {
  const comparisons = compareWindows(baseline, current);

  // HOR-435: panel-level two-population check. When a high-spike cluster AND a
  // low/zero/empty cluster are co-present across this panel's series, the per-series
  // labels (each "latency-spike" / "under load") overstate a uniform regression. We
  // reclassify the members of BOTH clusters as a single 'bimodal-population' signal —
  // possible per-segment variance — which de-anchors the engine. The stable middle
  // and lone outliers are untouched (detectBimodalPopulation is conservative).
  const bimodal = detectBimodalPopulation(comparisons);
  const spike = 1.5;
  const drop = 0.67;
  const isBimodalMember = (cmp: BaselineComparison): boolean => {
    const r = cmp.ratio;
    if (!Number.isFinite(r)) return true; // empty / Infinity run
    if (r >= spike) return true; // high cluster
    if (r === 0) return true; // empty / zero
    return r > 0 && r <= drop; // genuine low cluster
  };

  return comparisons.map((cmp): MetricFinding => {
    const baseAnomaly = classifyAnomaly(kind, cmp);
    const anomaly: Anomaly =
      bimodal.bimodal && baseAnomaly !== 'none' && isBimodalMember(cmp)
        ? 'bimodal-population'
        : baseAnomaly;

    // Determine lastValue: last sample of the current series matching these labels
    const currentSeries = current.find((s) => {
      const keys = Object.keys(cmp.labels);
      return keys.every((k) => s.labels[k] === cmp.labels[k]);
    });
    const lastValue =
      currentSeries !== undefined ? summarize(currentSeries).last : cmp.currentAvg;

    return {
      dashboardUid,
      panelTitle,
      kind,
      anomaly,
      labels: cmp.labels,
      baselineAvg: cmp.baselineAvg,
      currentAvg: cmp.currentAvg,
      ratio: cmp.ratio,
      lastValue,
    };
  });
}

// ---------------------------------------------------------------------------
// Evidence conversion
// ---------------------------------------------------------------------------

function anomalyLabel(anomaly: Anomaly): string {
  switch (anomaly) {
    case 'latency-spike':
      return 'Latency Spike';
    case 'error-rate-change':
      return 'Error Rate Change';
    case 'throughput-drop':
      return 'Throughput Drop';
    case 'queue-growth':
      return 'Queue Growth';
    case 'change':
      return 'Change';
    case 'bimodal-population':
      return 'Bimodal Population (possible per-segment variance)';
    case 'none':
      return 'No Anomaly';
  }
}

function anomalyRelevance(anomaly: Anomaly): number {
  switch (anomaly) {
    case 'latency-spike':
    case 'error-rate-change':
    case 'queue-growth':
      return 0.85;
    case 'throughput-drop':
      return 0.8;
    case 'change':
      return 0.55;
    // Lower than a confident single-cause spike: a two-population pattern is a
    // hypothesis ("per-segment variance"), not a uniform regression — keep the
    // engine honest by NOT presenting it with spike-level weight (HOR-435).
    case 'bimodal-population':
      return 0.6;
    case 'none':
      return 0;
  }
}

/**
 * Convert a list of MetricFindings (anomaly !== "none") into Evidence[].
 * One Evidence per finding.
 */
export function findingsToEvidence(
  findings: MetricFinding[],
  query: string,
  collectedAt: string,
): Evidence[] {
  return findings
    .filter((f) => f.anomaly !== 'none')
    .map((f, i): Evidence => {
      const ratioStr = Number.isFinite(f.ratio) ? `x${f.ratio.toFixed(2)}` : 'xinf';
      const title =
        `${anomalyLabel(f.anomaly)}: ${f.panelTitle} ${f.baselineAvg.toFixed(3)} -> ${f.currentAvg.toFixed(3)} (${ratioStr})`.slice(
          0,
          160,
        );

      return {
        id: `ev_metric_${i}`,
        source: 'metrics',
        kind: 'metric',
        title,
        timestamp: undefined,
        relevance: anomalyRelevance(f.anomaly),
        payload: f,
        links: {},
        provenance: { query, collectedAt },
      };
    });
}
