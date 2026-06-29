/**
 * Pure unit tests for duration.ts (HOR-434 — INFO-level duration-by-dimension).
 * No network — no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  parseDurationMs,
  extractByRegex,
  percentile,
  computeStat,
  extractDurationSamples,
  aggregateDurations,
  durationsByDimension,
  type DurationLogLike,
  type DurationDimensionOptions,
} from './duration.js';

describe('parseDurationMs', () => {
  it('parses compound forms', () => {
    expect(parseDurationMs('2m10s')).toBe(130_000);
    expect(parseDurationMs('1h2m3s')).toBe(3_600_000 + 120_000 + 3_000);
  });

  it('parses single units incl. an optional leading ~', () => {
    expect(parseDurationMs('19ms')).toBe(19);
    expect(parseDurationMs('~2m10s')).toBe(130_000);
    expect(parseDurationMs('1.5s')).toBe(1_500);
    expect(parseDurationMs('500us')).toBe(0.5);
  });

  it('reads "ms" as milliseconds, not minutes+seconds', () => {
    expect(parseDurationMs('19ms')).toBe(19);
    expect(parseDurationMs('250 ms')).toBe(250);
  });

  it('treats a bare number as milliseconds', () => {
    expect(parseDurationMs('130')).toBe(130);
  });

  it('extracts the duration token out of a noisy message', () => {
    expect(parseDurationMs('Completed MANAGE_SALES:KSA ~2m10s')).toBe(130_000);
  });

  it('returns null when nothing parses', () => {
    expect(parseDurationMs('no duration here')).toBeNull();
    expect(parseDurationMs('')).toBeNull();
  });
});

describe('extractByRegex', () => {
  it('returns the first capture group', () => {
    expect(extractByRegex('MANAGE_SALES:KSA', /:([A-Z]{2,})$/)).toBe('KSA');
  });
  it('returns null on no match', () => {
    expect(extractByRegex('nope', /:([A-Z]+)$/)).toBeNull();
  });
});

describe('percentile / computeStat', () => {
  it('computes nearest-rank percentile', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 50)).toBe(5);
  });

  it('computes avg/p95/count/min/max', () => {
    const stat = computeStat([10, 20, 30, 40]);
    expect(stat.avg).toBe(25);
    expect(stat.count).toBe(4);
    expect(stat.min).toBe(10);
    expect(stat.max).toBe(40);
    expect(stat.p95).toBe(40);
  });

  it('returns zeros for an empty set', () => {
    expect(computeStat([])).toEqual({ avg: 0, p95: 0, count: 0, min: 0, max: 0 });
  });
});

// ---------------------------------------------------------------------------
// Extraction + aggregation
// ---------------------------------------------------------------------------

function line(message: string, fields: Record<string, unknown> = {}): DurationLogLike {
  return { message, fields: { message, ...fields } };
}

describe('extractDurationSamples', () => {
  it('extracts dimension (regex over message) + duration (message) per completion line', () => {
    const records = [
      line('Completed MANAGE_SALES:KSA ~2m10s'),
      line('Completed MANAGE_SALES:UAE ~19ms'),
      line('Completed MANAGE_SALES:KSA ~2m0s'),
      line('Heartbeat tick'), // not a completion line — skipped by completionText
    ];
    const opts: DurationDimensionOptions = {
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
      completionText: 'Completed',
    };
    const samples = extractDurationSamples(records, opts);
    expect(samples).toEqual([
      { dimension: 'KSA', durationMs: 130_000 },
      { dimension: 'UAE', durationMs: 19 },
      { dimension: 'KSA', durationMs: 120_000 },
    ]);
  });

  it('reads dimension + duration from structured fields when configured', () => {
    const records = [
      line('done', { context: { market: 'KSA' }, duration_ms: 130_000 }),
      line('done', { context: { market: 'UAE' }, duration_ms: 19 }),
    ];
    const opts: DurationDimensionOptions = {
      dimension: { name: 'market', field: 'context.market' },
      durationField: 'duration_ms',
    };
    const samples = extractDurationSamples(records, opts);
    expect(samples).toEqual([
      { dimension: 'KSA', durationMs: 130_000 },
      { dimension: 'UAE', durationMs: 19 },
    ]);
  });

  it('converts a seconds-unit numeric duration field to ms', () => {
    const records = [line('done', { region: 'KSA', elapsed_s: 2 })];
    const opts: DurationDimensionOptions = {
      dimension: { name: 'region', field: 'region' },
      durationField: 'elapsed_s',
      durationFieldUnit: 's',
    };
    expect(extractDurationSamples(records, opts)).toEqual([
      { dimension: 'KSA', durationMs: 2_000 },
    ]);
  });

  it('skips lines with no extractable dimension or no parseable duration', () => {
    const records = [
      line('Completed JOB ~5s'), // no region token
      line('Completed JOB:KSA no-duration'),
    ];
    const opts: DurationDimensionOptions = {
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
      completionText: 'Completed',
    };
    expect(extractDurationSamples(records, opts)).toEqual([]);
  });
});

describe('aggregateDurations / durationsByDimension', () => {
  it('produces per-dimension stats keyed by value', () => {
    const out = aggregateDurations(
      [
        { dimension: 'KSA', durationMs: 130_000 },
        { dimension: 'KSA', durationMs: 120_000 },
        { dimension: 'UAE', durationMs: 19 },
      ],
      'region',
    );
    expect(out).not.toBeNull();
    expect(out!.dimension).toBe('region');
    expect(out!.unit).toBe('ms');
    expect(out!.sampleCount).toBe(3);
    expect(out!.byValue['KSA']!.count).toBe(2);
    expect(out!.byValue['KSA']!.avg).toBe(125_000);
    expect(out!.byValue['UAE']!.count).toBe(1);
    expect(out!.byValue['UAE']!.avg).toBe(19);
  });

  it('returns null when there are no samples (graceful "nothing to report")', () => {
    expect(aggregateDurations([], 'region')).toBeNull();
  });

  it('durationsByDimension end-to-end returns the {region:{KSA,UAE}} shape', () => {
    const records = [
      line('Completed MANAGE_SALES:KSA ~2m10s'),
      line('Completed MANAGE_SALES:UAE ~19ms'),
    ];
    const out = durationsByDimension(records, {
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
      completionText: 'Completed',
    });
    expect(Object.keys(out!.byValue).sort()).toEqual(['KSA', 'UAE']);
    expect(out!.byValue['KSA']!.avg).toBe(130_000);
    expect(out!.byValue['UAE']!.avg).toBe(19);
  });

  it('returns null when nothing usable is found (no completion lines)', () => {
    const records = [line('just a heartbeat')];
    const out = durationsByDimension(records, {
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
      completionText: 'Completed',
    });
    expect(out).toBeNull();
  });
});
