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
  return comparisons.map((cmp): MetricFinding => {
    const anomaly = classifyAnomaly(kind, cmp);

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
