/**
 * HOR-217 — failed-job age + staleness on BullMQ queue signals.
 *
 * A failed job's error must carry how long ago it failed so investigations don't
 * report a stale 401 as a live incident.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeQueueSignals,
  isStaleFailure,
  STALE_FAILED_MS,
  type QueueCounts,
} from './analyze.js';

const base: QueueCounts = {
  queueName: 'GAIA_STOCK_SYNC',
  waiting: 0,
  active: 1,
  failed: 30,
  delayed: 0,
  completed: 100,
  paused: 0,
  isPaused: false,
};

describe('isStaleFailure', () => {
  it('treats undefined age as not stale', () => {
    expect(isStaleFailure(undefined)).toBe(false);
  });
  it('flags ages older than the threshold', () => {
    expect(isStaleFailure(STALE_FAILED_MS + 1)).toBe(true);
    expect(isStaleFailure(STALE_FAILED_MS - 1)).toBe(false);
  });
});

describe('failed-spike signal age (HOR-217)', () => {
  it('shows the most-recent age and STALE marker for an old failure', () => {
    const sigs = analyzeQueueSignals({
      ...base,
      newestFailedAgeMs: 4 * 86_400_000, // 4 days
    });
    const spike = sigs.find((s) => s.kind === 'failed-spike');
    expect(spike).toBeDefined();
    expect(spike!.title).toContain('most recent 4d ago');
    expect(spike!.title).toContain('STALE');
    expect(spike!.payload['stale']).toBe(true);
    // Stale failures are hedged down so they don't read as the live incident.
    expect(spike!.relevance).toBe(0.5);
  });

  it('does not mark a recent failure stale', () => {
    const sigs = analyzeQueueSignals({
      ...base,
      newestFailedAgeMs: 5 * 60_000, // 5 minutes
    });
    const spike = sigs.find((s) => s.kind === 'failed-spike');
    expect(spike!.title).toContain('most recent 5m ago');
    expect(spike!.title).not.toContain('STALE');
    expect(spike!.payload['stale']).toBe(false);
  });

  it('omits age text when no timestamp is available', () => {
    const sigs = analyzeQueueSignals(base);
    const spike = sigs.find((s) => s.kind === 'failed-spike');
    expect(spike!.title).not.toContain('most recent');
    expect(spike!.payload['newestFailedAgeMs']).toBeNull();
  });
});

describe('failed-breakdown signal age (HOR-217)', () => {
  it('annotates the dominant reason with last-failed age + STALE', () => {
    const sigs = analyzeQueueSignals({
      ...base,
      failed: 10,
      failedBreakdown: [
        { reason: 'Gaia API fetch failed: status code 401', count: 10, lastFailedAgeMs: 4 * 86_400_000 },
      ],
    });
    const bd = sigs.find((s) => s.kind === 'failed-breakdown');
    expect(bd).toBeDefined();
    expect(bd!.title).toContain('last failed 4d ago');
    expect(bd!.title).toContain('[STALE]');
    expect(bd!.payload['topStale']).toBe(true);
  });
});
