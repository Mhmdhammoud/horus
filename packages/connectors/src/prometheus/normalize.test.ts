/**
 * Pure unit tests for prometheus/normalize.ts (HOR-11). No network — no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  parseValue,
  parseInstant,
  parseRange,
  summarize,
  compareWindows,
  detectSpikes,
  metricsToEvidence,
  comparisonsToEvidence,
} from './normalize.js';
import type { MetricSeries } from './normalize.js';

// ---------------------------------------------------------------------------
// parseValue
// ---------------------------------------------------------------------------

describe('parseValue', () => {
  it('parses a normal numeric string', () => {
    expect(parseValue('1.5')).toBe(1.5);
  });

  it('parses "0"', () => {
    expect(parseValue('0')).toBe(0);
  });

  it('parses "NaN" as NaN', () => {
    expect(parseValue('NaN')).toBeNaN();
  });

  it('parses "+Inf" as Infinity', () => {
    expect(parseValue('+Inf')).toBe(Infinity);
  });

  it('parses "-Inf" as -Infinity', () => {
    expect(parseValue('-Inf')).toBe(-Infinity);
  });

  it('parses an integer string', () => {
    expect(parseValue('42')).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// parseInstant
// ---------------------------------------------------------------------------

const instantFixture = {
  status: 'success',
  data: {
    resultType: 'vector',
    result: [
      {
        metric: { __name__: 'up', job: 'prometheus', instance: 'localhost:9090' },
        value: [1718323200, '1'],
      },
      {
        metric: { __name__: 'up', job: 'node', instance: 'node1:9100' },
        value: [1718323200, '0'],
      },
    ],
  },
};

describe('parseInstant', () => {
  it('returns one MetricSeries per result element', () => {
    const series = parseInstant(instantFixture);
    expect(series).toHaveLength(2);
  });

  it('preserves labels', () => {
    const series = parseInstant(instantFixture);
    expect(series[0]?.labels['__name__']).toBe('up');
    expect(series[0]?.labels['job']).toBe('prometheus');
    expect(series[0]?.labels['instance']).toBe('localhost:9090');
  });

  it('creates exactly one sample per result', () => {
    const series = parseInstant(instantFixture);
    expect(series[0]?.samples).toHaveLength(1);
    expect(series[0]?.samples[0]?.t).toBe(1718323200);
    expect(series[0]?.samples[0]?.v).toBe(1);
  });

  it('returns [] for missing data', () => {
    expect(parseInstant({})).toEqual([]);
  });

  it('returns [] when result is not an array', () => {
    expect(parseInstant({ data: { result: null } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseRange
// ---------------------------------------------------------------------------

const rangeFixture = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [
      {
        metric: { __name__: 'node_load1', instance: 'node1:9100' },
        values: [
          [1718320000, '0.5'],
          [1718320060, '0.7'],
          [1718320120, '0.9'],
        ],
      },
    ],
  },
};

describe('parseRange', () => {
  it('returns one series per result element', () => {
    const series = parseRange(rangeFixture);
    expect(series).toHaveLength(1);
  });

  it('maps values array to MetricSample[]', () => {
    const series = parseRange(rangeFixture);
    const samples = series[0]?.samples;
    expect(samples).toHaveLength(3);
    expect(samples?.[0]?.t).toBe(1718320000);
    expect(samples?.[0]?.v).toBe(0.5);
    expect(samples?.[2]?.v).toBe(0.9);
  });

  it('returns [] for missing data', () => {
    expect(parseRange({})).toEqual([]);
  });

  it('handles series with empty values array', () => {
    const resp = { data: { result: [{ metric: { __name__: 'up' }, values: [] }] } };
    const series = parseRange(resp);
    expect(series[0]?.samples).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

const makeSeriesFromValues = (vals: number[]): MetricSeries => ({
  labels: { __name__: 'test' },
  samples: vals.map((v, i) => ({ t: 1718320000 + i * 60, v })),
});

describe('summarize', () => {
  it('computes correct min/max/avg/last/count', () => {
    const s = makeSeriesFromValues([2, 4, 6, 8]);
    const result = summarize(s);
    expect(result.min).toBe(2);
    expect(result.max).toBe(8);
    expect(result.avg).toBe(5);
    expect(result.last).toBe(8); // highest t
    expect(result.count).toBe(4);
  });

  it('ignores NaN values', () => {
    const s: MetricSeries = {
      labels: {},
      samples: [
        { t: 1, v: NaN },
        { t: 2, v: 4 },
        { t: 3, v: 6 },
      ],
    };
    const result = summarize(s);
    expect(result.count).toBe(2);
    expect(result.avg).toBe(5);
  });

  it('returns zeros when all samples are NaN', () => {
    const s: MetricSeries = {
      labels: {},
      samples: [{ t: 1, v: NaN }],
    };
    const result = summarize(s);
    expect(result.count).toBe(0);
    expect(result.avg).toBe(0);
    expect(result.min).toBe(0);
    expect(result.max).toBe(0);
  });

  it('returns zeros for empty samples', () => {
    const s: MetricSeries = { labels: {}, samples: [] };
    const result = summarize(s);
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// compareWindows
// ---------------------------------------------------------------------------

describe('compareWindows', () => {
  it('detects a spike when ratio >= spikeRatio', () => {
    const baseline: MetricSeries[] = [
      {
        labels: { __name__: 'http_errors', job: 'api' },
        samples: [{ t: 1, v: 2 }],
      },
    ];
    const current: MetricSeries[] = [
      {
        labels: { __name__: 'http_errors', job: 'api' },
        samples: [{ t: 2, v: 6 }],
      },
    ];

    const cmps = compareWindows(baseline, current, 1.5);
    expect(cmps).toHaveLength(1);
    const c = cmps[0]!;
    expect(c.baselineAvg).toBe(2);
    expect(c.currentAvg).toBe(6);
    expect(c.delta).toBe(4);
    expect(c.ratio).toBe(3);
    expect(c.isSpike).toBe(true);
  });

  it('does not mark as spike when ratio < spikeRatio', () => {
    const baseline: MetricSeries[] = [
      { labels: { __name__: 'cpu', job: 'node' }, samples: [{ t: 1, v: 4 }] },
    ];
    const current: MetricSeries[] = [
      { labels: { __name__: 'cpu', job: 'node' }, samples: [{ t: 2, v: 5 }] },
    ];

    const cmps = compareWindows(baseline, current, 1.5);
    expect(cmps[0]?.isSpike).toBe(false);
  });

  it('handles zero baseline -> ratio Infinity when current > 0', () => {
    const baseline: MetricSeries[] = [
      { labels: { __name__: 'm', job: 'svc' }, samples: [{ t: 1, v: 0 }] },
    ];
    const current: MetricSeries[] = [
      { labels: { __name__: 'm', job: 'svc' }, samples: [{ t: 2, v: 5 }] },
    ];

    const cmps = compareWindows(baseline, current, 1.5);
    expect(cmps[0]?.ratio).toBe(Infinity);
    expect(cmps[0]?.isSpike).toBe(true); // Infinity >= 1.5
  });

  it('returns ratio 0 when both baseline and current are 0', () => {
    const baseline: MetricSeries[] = [
      { labels: { __name__: 'm', job: 'svc' }, samples: [{ t: 1, v: 0 }] },
    ];
    const current: MetricSeries[] = [
      { labels: { __name__: 'm', job: 'svc' }, samples: [{ t: 2, v: 0 }] },
    ];

    const cmps = compareWindows(baseline, current, 1.5);
    expect(cmps[0]?.ratio).toBe(0);
    expect(cmps[0]?.isSpike).toBe(false);
  });

  it('uses baselineAvg=0 for series not in baseline (new series)', () => {
    const baseline: MetricSeries[] = [];
    const current: MetricSeries[] = [
      { labels: { __name__: 'new_metric', job: 'svc' }, samples: [{ t: 1, v: 10 }] },
    ];

    const cmps = compareWindows(baseline, current, 1.5);
    expect(cmps[0]?.baselineAvg).toBe(0);
    expect(cmps[0]?.ratio).toBe(Infinity);
  });

  it('sorts comparisons by delta descending', () => {
    const baseline: MetricSeries[] = [
      { labels: { __name__: 'a', job: 'svc' }, samples: [{ t: 1, v: 1 }] },
      { labels: { __name__: 'b', job: 'svc' }, samples: [{ t: 1, v: 1 }] },
    ];
    const current: MetricSeries[] = [
      { labels: { __name__: 'a', job: 'svc' }, samples: [{ t: 2, v: 2 }] }, // delta 1
      { labels: { __name__: 'b', job: 'svc' }, samples: [{ t: 2, v: 10 }] }, // delta 9
    ];

    const cmps = compareWindows(baseline, current);
    expect(cmps[0]?.labels['__name__']).toBe('b');
    expect(cmps[1]?.labels['__name__']).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// detectSpikes
// ---------------------------------------------------------------------------

describe('detectSpikes', () => {
  it('flags the outlier value 10 in [1, 1, 1, 10] with k=2', () => {
    const s: MetricSeries = {
      labels: {},
      samples: [
        { t: 1, v: 1 },
        { t: 2, v: 1 },
        { t: 3, v: 1 },
        { t: 4, v: 10 },
      ],
    };
    const spikes = detectSpikes(s, 2);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]?.v).toBe(10);
    expect(spikes[0]?.z).toBeGreaterThan(2);
  });

  it('returns [] when all values are equal (std = 0)', () => {
    const s = makeSeriesFromValues([5, 5, 5, 5]);
    expect(detectSpikes(s)).toEqual([]);
  });

  it('returns [] for < 2 samples', () => {
    const s: MetricSeries = {
      labels: {},
      samples: [{ t: 1, v: 100 }],
    };
    expect(detectSpikes(s)).toEqual([]);
  });

  it('ignores NaN samples when computing mean/std', () => {
    const s: MetricSeries = {
      labels: {},
      samples: [
        { t: 1, v: NaN },
        { t: 2, v: 1 },
        { t: 3, v: 1 },
        { t: 4, v: 1 },
        { t: 5, v: 20 },
      ],
    };
    const spikes = detectSpikes(s, 2);
    expect(spikes.some((p) => p.v === 20)).toBe(true);
  });

  it('returns correct z-score fields on spike points', () => {
    const s = makeSeriesFromValues([1, 1, 1, 10]);
    const spikes = detectSpikes(s, 2);
    const spike = spikes[0]!;
    expect(spike).toHaveProperty('t');
    expect(spike).toHaveProperty('v');
    expect(spike).toHaveProperty('mean');
    expect(spike).toHaveProperty('std');
    expect(spike).toHaveProperty('z');
  });
});

// ---------------------------------------------------------------------------
// metricsToEvidence
// ---------------------------------------------------------------------------

describe('metricsToEvidence', () => {
  it('produces Evidence items with source "metrics" and kind "metric"', () => {
    const summaries = [
      {
        labels: { __name__: 'node_load1', job: 'node', instance: 'node1:9100' },
        min: 0.1,
        max: 1.5,
        avg: 0.8,
        last: 0.9,
        count: 60,
      },
    ];
    const evidence = metricsToEvidence(summaries, 'node_load1', '2026-06-14T00:00:00Z');
    expect(evidence).toHaveLength(1);
    const ev = evidence[0]!;
    expect(ev.source).toBe('metrics');
    expect(ev.kind).toBe('metric');
    expect(ev.relevance).toBe(0.6);
    expect(ev.provenance.query).toBe('node_load1');
    expect(ev.provenance.collectedAt).toBe('2026-06-14T00:00:00Z');
  });

  it('includes __name__ and job in the title', () => {
    const summaries = [
      {
        labels: { __name__: 'cpu_usage', job: 'cadvisor' },
        min: 0,
        max: 1,
        avg: 0.5,
        last: 0.6,
        count: 10,
      },
    ];
    const evidence = metricsToEvidence(summaries, 'q', '2026-06-14T00:00:00Z');
    const ev = evidence[0]!;
    expect(ev.title).toContain('cpu_usage');
    expect(ev.title).toContain('cadvisor');
  });

  it('sets title length <= 160', () => {
    const summaries = [
      {
        labels: { __name__: 'a'.repeat(200) },
        min: 0,
        max: 0,
        avg: 0,
        last: 0,
        count: 0,
      },
    ];
    const evidence = metricsToEvidence(summaries, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.title.length).toBeLessThanOrEqual(160);
  });

  it('assigns sequential ids ev_metric_0, ev_metric_1, etc.', () => {
    const summaries = [
      { labels: {}, min: 0, max: 1, avg: 0.5, last: 0.5, count: 2 },
      { labels: {}, min: 0, max: 2, avg: 1, last: 1, count: 2 },
    ];
    const evidence = metricsToEvidence(summaries, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.id).toBe('ev_metric_0');
    expect(evidence[1]?.id).toBe('ev_metric_1');
  });

  it('sets links to an empty object', () => {
    const summaries = [{ labels: {}, min: 0, max: 1, avg: 0.5, last: 0.5, count: 1 }];
    const evidence = metricsToEvidence(summaries, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.links).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// comparisonsToEvidence
// ---------------------------------------------------------------------------

describe('comparisonsToEvidence', () => {
  it('sets relevance 0.85 when isSpike is true', () => {
    const cmps = [
      {
        labels: { __name__: 'errors', job: 'api' },
        baselineAvg: 2,
        currentAvg: 10,
        delta: 8,
        ratio: 5,
        isSpike: true,
      },
    ];
    const evidence = comparisonsToEvidence(cmps, 'errors', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.relevance).toBe(0.85);
  });

  it('sets relevance 0.5 when isSpike is false', () => {
    const cmps = [
      {
        labels: { __name__: 'cpu', job: 'node' },
        baselineAvg: 0.4,
        currentAvg: 0.5,
        delta: 0.1,
        ratio: 1.25,
        isSpike: false,
      },
    ];
    const evidence = comparisonsToEvidence(cmps, 'cpu', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.relevance).toBe(0.5);
  });

  it('sets source "metrics" and kind "metric"', () => {
    const cmps = [
      {
        labels: {},
        baselineAvg: 1,
        currentAvg: 2,
        delta: 1,
        ratio: 2,
        isSpike: false,
      },
    ];
    const evidence = comparisonsToEvidence(cmps, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.source).toBe('metrics');
    expect(evidence[0]?.kind).toBe('metric');
  });

  it('renders Infinity ratio as "inf" in the title', () => {
    const cmps = [
      {
        labels: { __name__: 'm' },
        baselineAvg: 0,
        currentAvg: 5,
        delta: 5,
        ratio: Infinity,
        isSpike: true,
      },
    ];
    const evidence = comparisonsToEvidence(cmps, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.title).toContain('xinf');
  });

  it('includes provenance', () => {
    const cmps = [
      {
        labels: {},
        baselineAvg: 0,
        currentAvg: 0,
        delta: 0,
        ratio: 0,
        isSpike: false,
      },
    ];
    const evidence = comparisonsToEvidence(cmps, 'my-query', '2026-06-14T00:00:00Z');
    expect(evidence[0]?.provenance.query).toBe('my-query');
    expect(evidence[0]?.provenance.collectedAt).toBe('2026-06-14T00:00:00Z');
  });
});
