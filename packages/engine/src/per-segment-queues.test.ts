/**
 * HOR-438 — Unit tests for detectPerSegmentQueues (pure, no I/O).
 *
 * Detects a per-segment queue STRUCTURE (one queue per market/region/tenant/shard) from
 * queue-edge topology. This is a code-grounded SUPPORT for benign-variance — never a verdict.
 */

import { describe, it, expect } from 'vitest';
import { detectPerSegmentQueues } from './engine.js';

function hits(...names: string[]): { queueName: string }[] {
  return names.map((queueName) => ({ queueName }));
}

describe('detectPerSegmentQueues (HOR-438)', () => {
  it('flags 2+ queues that share a base with DISTINCT segment suffixes', () => {
    const out = detectPerSegmentQueues(hits('MANAGE_SALES:KSA', 'MANAGE_SALES:UAE'));
    expect(out).toHaveLength(1);
    expect(out[0]!.baseName).toBe('MANAGE_SALES');
    expect(out[0]!.segments).toEqual(['KSA', 'UAE']); // distinct, sorted
    expect(out[0]!.count).toBe(2);
  });

  it('collapses duplicate edges on the SAME segment (distinct suffix count, not edge count)', () => {
    const out = detectPerSegmentQueues(
      hits('MANAGE_SALES:KSA', 'MANAGE_SALES:KSA', 'MANAGE_SALES:UAE'),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.segments).toEqual(['KSA', 'UAE']);
    expect(out[0]!.count).toBe(2);
  });

  it('false-positive guard: a SINGLE queue containing a `:` is NOT a pattern', () => {
    expect(detectPerSegmentQueues(hits('MANAGE_SALES:KSA'))).toHaveLength(0);
  });

  it('ignores unrelated queues with no shared base', () => {
    expect(detectPerSegmentQueues(hits('orders:KSA', 'payments:UAE'))).toHaveLength(0);
  });

  it('ignores queues with no segment delimiter at all', () => {
    expect(detectPerSegmentQueues(hits('orders', 'payments', 'sync-job'))).toHaveLength(0);
  });

  it('dimension sanity check: arbitrary long suffixes are NOT treated as segments', () => {
    // An incidental `:` (a namespaced key / URL / serialized blob) is not a segment fan-out.
    const out = detectPerSegmentQueues(
      hits(
        'JOB:this-is-a-very-long-arbitrary-string-not-a-segment',
        'JOB:another-extremely-long-arbitrary-non-segment-value',
      ),
    );
    expect(out).toHaveLength(0);
  });

  it('accepts realistic segment codes (regions/markets/shards/zones)', () => {
    const out = detectPerSegmentQueues(hits('sync:us-east', 'sync:eu1', 'sync:shard3'));
    expect(out).toHaveLength(1);
    expect(out[0]!.baseName).toBe('sync');
    expect(out[0]!.count).toBe(3);
  });

  it('detects multiple independent per-segment structures, deterministically ordered', () => {
    const out = detectPerSegmentQueues(
      hits('zeta:US', 'zeta:EU', 'alpha:KSA', 'alpha:UAE', 'solo:X'),
    );
    expect(out.map((s) => s.baseName)).toEqual(['alpha', 'zeta']); // sorted, `solo` dropped
  });

  it('does not fabricate from empty input', () => {
    expect(detectPerSegmentQueues([])).toEqual([]);
  });
});
