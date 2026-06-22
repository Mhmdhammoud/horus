/**
 * Pure unit tests for grafana/analyze.ts (HOR-11 reframe). No network — no I/O.
 */

import { describe, it, expect } from 'vitest';
import { classifyAnomaly, buildFindings, findingsToEvidence } from './analyze.js';
import type { MetricFinding } from './analyze.js';
import type { MetricSeries } from './series.js';
import type { BaselineComparison } from './series.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCmp(
  overrides: Partial<BaselineComparison> = {},
): BaselineComparison {
  return {
    labels: {},
    baselineAvg: 1,
    currentAvg: 1,
    delta: 0,
    ratio: 1,
    isSpike: false,
    ...overrides,
  };
}

function makeSeries(vals: number[], labels: Record<string, string> = {}): MetricSeries {
  return {
    labels,
    samples: vals.map((v, i) => ({ t: 1718320000 + i * 60, v })),
  };
}

// ---------------------------------------------------------------------------
// classifyAnomaly
// ---------------------------------------------------------------------------

describe('classifyAnomaly', () => {
  it('returns latency-spike when kind is latency and ratio >= spike threshold', () => {
    expect(classifyAnomaly('latency', makeCmp({ ratio: 4 }))).toBe('latency-spike');
  });

  it('suppresses a trivial zero-baseline blip (HOR-342)', () => {
    // 0 -> 24ms p95 on a no-traffic op: Infinity ratio but meaningless magnitude.
    expect(
      classifyAnomaly('latency', makeCmp({ baselineAvg: 0, currentAvg: 0.024, ratio: Infinity })),
    ).toBe('none');
    // 0 -> 0.03 queue depth: less than one job, not a backlog.
    expect(
      classifyAnomaly('queue', makeCmp({ baselineAvg: 0, currentAvg: 0.03, ratio: Infinity, delta: 0.03 })),
    ).toBe('none');
  });

  it('still flags a real zero-baseline spike that clears the floor (HOR-342)', () => {
    expect(
      classifyAnomaly('latency', makeCmp({ baselineAvg: 0, currentAvg: 2.4, ratio: Infinity })),
    ).toBe('latency-spike');
  });

  it('returns throughput-drop when kind is throughput and ratio <= drop threshold', () => {
    expect(
      classifyAnomaly('throughput', makeCmp({ ratio: 0.3, currentAvg: 0.3 })),
    ).toBe('throughput-drop');
  });

  it('does not flag throughput-drop when ratio is 0 (no baseline and no current)', () => {
    // ratio === 0 does not satisfy ratio > 0 && ratio <= drop
    expect(classifyAnomaly('throughput', makeCmp({ ratio: 0 }))).toBe('none');
  });

  it('returns queue-growth when kind is queue, ratio >= spike and delta > 0', () => {
    expect(
      classifyAnomaly('queue', makeCmp({ ratio: 2, delta: 5, currentAvg: 10 })),
    ).toBe('queue-growth');
  });

  it('returns queue-growth when kind is queue, currentAvg > baselineAvg and delta > 0', () => {
    // ratio < spike but currentAvg > baselineAvg
    expect(
      classifyAnomaly(
        'queue',
        makeCmp({ ratio: 1.2, delta: 3, baselineAvg: 5, currentAvg: 8 }),
      ),
    ).toBe('queue-growth');
  });

  it('returns error-rate-change when kind is error-rate and ratio >= spike', () => {
    expect(classifyAnomaly('error-rate', makeCmp({ ratio: 3 }))).toBe('error-rate-change');
  });

  it('returns change when ratio >= spike for a non-specific kind', () => {
    expect(classifyAnomaly('other', makeCmp({ ratio: 2 }))).toBe('change');
  });

  it('returns change when ratio <= drop for a non-specific kind', () => {
    expect(classifyAnomaly('saturation', makeCmp({ ratio: 0.5, currentAvg: 0.5 }))).toBe(
      'change',
    );
  });

  it('returns none when latency ratio is 1.0 (no change)', () => {
    expect(classifyAnomaly('latency', makeCmp({ ratio: 1.0 }))).toBe('none');
  });

  it('respects custom spike/drop thresholds', () => {
    expect(
      classifyAnomaly('latency', makeCmp({ ratio: 1.2 }), { spike: 1.1 }),
    ).toBe('latency-spike');

    expect(
      classifyAnomaly('throughput', makeCmp({ ratio: 0.8, currentAvg: 0.8 }), { drop: 0.9 }),
    ).toBe('throughput-drop');
  });
});

// ---------------------------------------------------------------------------
// buildFindings
// ---------------------------------------------------------------------------

describe('buildFindings', () => {
  it('produces one finding per current series', () => {
    const baseline = [makeSeries([1, 1], { route: '/health' })];
    const current = [makeSeries([4, 4], { route: '/health' })];

    const findings = buildFindings('uid1', 'HTTP Latency', 'latency', baseline, current);
    expect(findings).toHaveLength(1);
  });

  it('assigns correct anomaly for a latency spike', () => {
    const baseline = [makeSeries([1], { route: '/api' })];
    const current = [makeSeries([5], { route: '/api' })];

    const findings = buildFindings('uid1', 'HTTP p95 Latency', 'latency', baseline, current);
    expect(findings[0]?.anomaly).toBe('latency-spike');
  });

  it('assigns anomaly "none" for stable metrics', () => {
    const baseline = [makeSeries([10, 10])];
    const current = [makeSeries([10, 10])];

    const findings = buildFindings('uid1', 'CPU', 'saturation', baseline, current);
    expect(findings[0]?.anomaly).toBe('none');
  });

  it('carries dashboardUid and panelTitle through', () => {
    const baseline = [makeSeries([1])];
    const current = [makeSeries([3])];

    const findings = buildFindings('dash-xyz', 'BullMQ Queue Depth', 'queue', baseline, current);
    expect(findings[0]?.dashboardUid).toBe('dash-xyz');
    expect(findings[0]?.panelTitle).toBe('BullMQ Queue Depth');
  });

  it('sets lastValue to the last sample value of the matched current series', () => {
    const baseline = [makeSeries([1, 1], {})];
    const current = [makeSeries([2, 7], {})];

    const findings = buildFindings('uid1', 'p95', 'latency', baseline, current);
    // summarize picks the sample with the highest t; last value in the array has t=...+60
    expect(findings[0]?.lastValue).toBe(7);
  });

  it('returns empty array when current is empty', () => {
    const findings = buildFindings('uid1', 'Panel', 'other', [], []);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findingsToEvidence
// ---------------------------------------------------------------------------

describe('findingsToEvidence', () => {
  const latencyFinding: MetricFinding = {
    dashboardUid: 'dash1',
    panelTitle: 'HTTP p95 Latency',
    kind: 'latency',
    anomaly: 'latency-spike',
    labels: { route: '/api' },
    baselineAvg: 0.05,
    currentAvg: 0.25,
    ratio: 5,
    lastValue: 0.3,
  };

  const noneFinding: MetricFinding = {
    dashboardUid: 'dash1',
    panelTitle: 'Host CPU',
    kind: 'saturation',
    anomaly: 'none',
    labels: {},
    baselineAvg: 30,
    currentAvg: 31,
    ratio: 1.03,
    lastValue: 31,
  };

  it('excludes findings with anomaly "none"', () => {
    const evidence = findingsToEvidence(
      [latencyFinding, noneFinding],
      'grafana.analyze',
      '2026-06-14T00:00:00Z',
    );
    expect(evidence).toHaveLength(1);
  });

  it('assigns relevance 0.85 for latency-spike', () => {
    const evidence = findingsToEvidence(
      [latencyFinding],
      'grafana.analyze',
      '2026-06-14T00:00:00Z',
    );
    expect(evidence[0]?.relevance).toBe(0.85);
  });

  it('assigns relevance 0.8 for throughput-drop', () => {
    const finding: MetricFinding = {
      ...latencyFinding,
      anomaly: 'throughput-drop',
      kind: 'throughput',
    };
    const evidence = findingsToEvidence([finding], 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.relevance).toBe(0.8);
  });

  it('assigns relevance 0.85 for error-rate-change', () => {
    const finding: MetricFinding = {
      ...latencyFinding,
      anomaly: 'error-rate-change',
      kind: 'error-rate',
    };
    const evidence = findingsToEvidence([finding], 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.relevance).toBe(0.85);
  });

  it('assigns relevance 0.85 for queue-growth', () => {
    const finding: MetricFinding = {
      ...latencyFinding,
      anomaly: 'queue-growth',
      kind: 'queue',
    };
    const evidence = findingsToEvidence([finding], 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.relevance).toBe(0.85);
  });

  it('assigns relevance 0.55 for change', () => {
    const finding: MetricFinding = {
      ...latencyFinding,
      anomaly: 'change',
      kind: 'other',
    };
    const evidence = findingsToEvidence([finding], 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.relevance).toBe(0.55);
  });

  it('includes the anomaly name in the title', () => {
    const evidence = findingsToEvidence(
      [latencyFinding],
      'grafana.analyze',
      '2026-06-14T00:00:00Z',
    );
    expect(evidence[0]?.title).toContain('Latency Spike');
  });

  it('includes before/after averages in the title', () => {
    const evidence = findingsToEvidence(
      [latencyFinding],
      'grafana.analyze',
      '2026-06-14T00:00:00Z',
    );
    expect(evidence[0]?.title).toContain('0.050');
    expect(evidence[0]?.title).toContain('0.250');
  });

  it('sets source "metrics" and kind "metric"', () => {
    const evidence = findingsToEvidence([latencyFinding], 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.source).toBe('metrics');
    expect(evidence[0]?.kind).toBe('metric');
  });

  it('sets provenance correctly', () => {
    const evidence = findingsToEvidence(
      [latencyFinding],
      'grafana.analyze',
      '2026-06-14T00:00:00Z',
    );
    expect(evidence[0]?.provenance.query).toBe('grafana.analyze');
    expect(evidence[0]?.provenance.collectedAt).toBe('2026-06-14T00:00:00Z');
  });

  it('returns empty array when all findings are "none"', () => {
    const evidence = findingsToEvidence([noneFinding], 'q', '2026-06-14T00:00:00Z');
    expect(evidence).toHaveLength(0);
  });
});
