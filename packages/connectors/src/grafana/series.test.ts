/**
 * Pure unit tests for grafana/series.ts (HOR-11 reframe).
 * No network — no I/O. Relocated from prometheus/normalize.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  parseValue,
  parseInstant,
  parseRange,
  summarize,
  compareWindows,
  detectSpikes,
  quartiles,
  histogram,
  detectBimodalPopulation,
} from './series.js';
import type { MetricSeries, BaselineComparison } from './series.js';

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
// quartiles / histogram (HOR-435 distribution support)
// ---------------------------------------------------------------------------

describe('quartiles', () => {
  it('computes a five-number summary', () => {
    const q = quartiles([1, 2, 3, 4, 5]);
    expect(q).not.toBeNull();
    expect(q!.min).toBe(1);
    expect(q!.median).toBe(3);
    expect(q!.max).toBe(5);
    expect(q!.iqr).toBe(q!.q3 - q!.q1);
  });

  it('ignores non-finite values and returns null when none are finite', () => {
    expect(quartiles([Infinity, NaN])).toBeNull();
    const q = quartiles([Infinity, 10, NaN]);
    expect(q!.min).toBe(10);
    expect(q!.max).toBe(10);
  });
});

describe('histogram', () => {
  it('buckets finite values into equal-width bins, max in the final bin', () => {
    const bins = histogram([0, 1, 2, 9, 10], 5);
    expect(bins).toHaveLength(5);
    const total = bins.reduce((a, b) => a + b.count, 0);
    expect(total).toBe(5);
    expect(bins[bins.length - 1]!.count).toBeGreaterThanOrEqual(1); // 10 lands last
  });

  it('returns a single bin when all values are equal', () => {
    expect(histogram([4, 4, 4])).toEqual([{ lo: 4, hi: 4, count: 3 }]);
  });

  it('returns [] when there are no finite values', () => {
    expect(histogram([Infinity, NaN])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectBimodalPopulation (HOR-435)
// ---------------------------------------------------------------------------

function cmp(ratio: number, overrides: Partial<BaselineComparison> = {}): BaselineComparison {
  return {
    labels: {},
    baselineAvg: 1,
    currentAvg: ratio,
    delta: ratio - 1,
    ratio,
    isSpike: ratio >= 1.5,
    ...overrides,
  };
}

describe('detectBimodalPopulation', () => {
  it('flags a co-present high-spike + low + empty/Infinity pattern', () => {
    const res = detectBimodalPopulation([
      cmp(3.3),
      cmp(3.1),
      cmp(0.5),
      cmp(0.45),
      cmp(Infinity), // empty / no-baseline run
    ]);
    expect(res.bimodal).toBe(true);
    expect(res.highCount).toBe(2);
    expect(res.lowCount).toBe(2);
    expect(res.degenerateCount).toBe(1);
  });

  it('does NOT flag a genuine single outlier among normals', () => {
    // One spike, the rest stable (~1.0) — no counter-population.
    const res = detectBimodalPopulation([cmp(3.3), cmp(1.0), cmp(1.05), cmp(0.98)]);
    expect(res.bimodal).toBe(false);
  });

  it('does NOT flag a single low straggler against a spiking majority', () => {
    // Lone low member (count 1, share 20%) — below the minMinority floor.
    const res = detectBimodalPopulation([
      cmp(3.0),
      cmp(3.1),
      cmp(2.9),
      cmp(3.2),
      cmp(0.5),
    ]);
    expect(res.bimodal).toBe(false);
  });

  it('does NOT flag two adjacent clusters under loosened thresholds (gap guard)', () => {
    // high median ~1.225, low median ~0.91 → ratio ~1.35 < gapFactor → not a real gap.
    const res = detectBimodalPopulation(
      [cmp(1.2), cmp(1.25), cmp(0.9), cmp(0.92)],
      { spike: 1.1, drop: 0.95, gapFactor: 2 },
    );
    expect(res.bimodal).toBe(false);
  });

  it('requires a minimum total population', () => {
    expect(detectBimodalPopulation([cmp(3.3), cmp(0.4)]).bimodal).toBe(false);
  });

  it('flags a high cluster co-present with an all-empty counter-population', () => {
    const res = detectBimodalPopulation([
      cmp(3.3),
      cmp(3.1),
      cmp(Infinity),
      cmp(0, { currentAvg: 0, delta: -1 }),
    ]);
    expect(res.bimodal).toBe(true);
    expect(res.degenerateCount).toBe(2);
  });
});
