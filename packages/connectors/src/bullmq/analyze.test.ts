import { describe, it, expect } from 'vitest';
import {
  fmtMs,
  analyzeQueueSignals,
  analyzeQueueRuntime,
  queueStateToEvidence,
  type QueueCounts,
  type QueueRuntimeState,
} from './analyze.js';

describe('fmtMs', () => {
  it('formats durations correctly', () => {
    expect(fmtMs(30_000)).toBe('30s');
    expect(fmtMs(90_000)).toBe('1m');
    expect(fmtMs(3_600_000)).toBe('1h');
    expect(fmtMs(86_400_000)).toBe('1d');
  });
});

const healthy: QueueCounts = {
  queueName: 'email-send',
  waiting: 2,
  active: 3,
  failed: 0,
  delayed: 0,
  completed: 1000,
  paused: 0,
  isPaused: false,
};

const backlogged: QueueCounts = {
  queueName: 'zoho-sync-realtime',
  waiting: 4_382,
  active: 1,
  failed: 12,
  delayed: 0,
  completed: 500,
  paused: 0,
  isPaused: false,
};

const starved: QueueCounts = {
  queueName: 'token-refresh',
  waiting: 423,
  active: 0,
  failed: 0,
  delayed: 0,
  completed: 200,
  paused: 0,
  isPaused: false,
};

const failingWithBreakdown: QueueCounts = {
  queueName: 'crm-webhook',
  waiting: 0,
  active: 1,
  failed: 120,
  delayed: 5,
  completed: 800,
  paused: 0,
  isPaused: false,
  failedBreakdown: [
    { reason: 'TokenRefreshFailed: 401 Unauthorized', count: 100 },
    { reason: 'NetworkError: ETIMEDOUT', count: 20 },
  ],
};

const oldJob: QueueCounts = {
  queueName: 'report-gen',
  waiting: 15,
  active: 0,
  failed: 0,
  delayed: 0,
  completed: 50,
  paused: 0,
  isPaused: false,
  oldestWaitingMs: 75 * 60_000, // 75 minutes
};

describe('analyzeQueueSignals', () => {
  it('emits only a summary for a healthy queue', () => {
    const sigs = analyzeQueueSignals(healthy);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.kind).toBe('summary');
    expect(sigs[0]!.relevance).toBe(0.4);
    expect(sigs[0]!.title).toContain('email-send');
  });

  it('emits a severe backlog signal for 4,382 waiting jobs', () => {
    const sigs = analyzeQueueSignals(backlogged);
    const backlog = sigs.find((s) => s.kind === 'backlog');
    expect(backlog).toBeDefined();
    expect(backlog!.title).toContain('4,382');
    expect(backlog!.title).toContain('severe');
    expect(backlog!.relevance).toBe(0.88);
  });

  it('emits worker-starvation when queue has waiting jobs but no active workers', () => {
    const sigs = analyzeQueueSignals(starved);
    const starvation = sigs.find((s) => s.kind === 'worker-starvation');
    expect(starvation).toBeDefined();
    expect(starvation!.title).toContain('423');
    expect(starvation!.title).toContain('0 active workers');
    expect(starvation!.relevance).toBe(0.7);
  });

  it('starvation takes precedence over plain backlog signal', () => {
    // report-gen: 15 waiting + 0 active → starvation, not backlog
    const sigs = analyzeQueueSignals(oldJob);
    expect(sigs.some((s) => s.kind === 'worker-starvation')).toBe(true);
    expect(sigs.some((s) => s.kind === 'backlog')).toBe(false);
  });

  it('emits failed-spike and failed-breakdown when failures dominate', () => {
    const sigs = analyzeQueueSignals(failingWithBreakdown);
    expect(sigs.some((s) => s.kind === 'failed-spike')).toBe(true);
    const breakdown = sigs.find((s) => s.kind === 'failed-breakdown');
    expect(breakdown).toBeDefined();
    expect(breakdown!.title).toContain('83%'); // 100/120 ≈ 83%
    expect(breakdown!.title).toContain('TokenRefreshFailed');
  });

  it('emits oldest-job signal when job is older than 5 minutes', () => {
    const sigs = analyzeQueueSignals(oldJob);
    const oldest = sigs.find((s) => s.kind === 'oldest-job');
    expect(oldest).toBeDefined();
    expect(oldest!.title).toContain('severe'); // > 1h
    expect(oldest!.relevance).toBe(0.85);
  });

  it('always includes a summary signal', () => {
    for (const q of [healthy, backlogged, starved, failingWithBreakdown, oldJob]) {
      const sigs = analyzeQueueSignals(q);
      expect(sigs.some((s) => s.kind === 'summary')).toBe(true);
    }
  });
});

describe('analyzeQueueRuntime', () => {
  it('flattens signals across all queues', () => {
    const state: QueueRuntimeState = {
      prefix: 'bull',
      collectedAt: '2026-06-14T12:00:00Z',
      queues: [healthy, backlogged, starved],
    };
    const sigs = analyzeQueueRuntime(state);
    const queueNames = [...new Set(sigs.map((s) => s.queueName))];
    expect(queueNames).toContain('email-send');
    expect(queueNames).toContain('zoho-sync-realtime');
    expect(queueNames).toContain('token-refresh');
  });
});

describe('queueStateToEvidence', () => {
  const state: QueueRuntimeState = {
    prefix: 'bull',
    collectedAt: '2026-06-14T12:00:00Z',
    queues: [backlogged, failingWithBreakdown],
  };

  it('produces Evidence records with correct source and kind', () => {
    const evs = queueStateToEvidence(state, 'Zoho sync delays', '2026-06-14T12:00:00Z');
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.source === 'queue')).toBe(true);
    expect(evs.every((e) => e.kind === 'queue-state')).toBe(true);
  });

  it('sets queueName in links', () => {
    const evs = queueStateToEvidence(state, 'test', '2026-06-14T12:00:00Z');
    const backlogEv = evs.find(
      (e) => e.links.queueName === 'zoho-sync-realtime' && (e.payload as { waiting?: number }).waiting === 4_382,
    );
    expect(backlogEv).toBeDefined();
  });

  it('includes high-relevance evidence for anomalous queues', () => {
    const evs = queueStateToEvidence(state, 'test', '2026-06-14T12:00:00Z');
    expect(evs.some((e) => e.relevance >= 0.8)).toBe(true);
  });

  it('assigns unique sequential ids', () => {
    const evs = queueStateToEvidence(state, 'test', '2026-06-14T12:00:00Z');
    const ids = evs.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
