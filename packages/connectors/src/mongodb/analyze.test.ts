import { describe, it, expect } from 'vitest';
import {
  pickField,
  isAnomalousStatus,
  ageHoursOf,
  stateToEvidence,
  DATE_FIELDS,
  STATUS_FIELDS,
  type StateAnalysis,
} from './analyze.js';

describe('pickField', () => {
  it('returns the first candidate present in the fields', () => {
    expect(pickField(['_id', 'createdAt', 'status'], DATE_FIELDS)).toBe('createdAt');
    // completedAt has higher priority than createdAt
    expect(pickField(['createdAt', 'completedAt'], DATE_FIELDS)).toBe('completedAt');
    expect(pickField(['_id', 'last_run_status'], STATUS_FIELDS)).toBe('last_run_status');
  });
  it('returns undefined when no candidate matches', () => {
    expect(pickField(['_id', 'name'], STATUS_FIELDS)).toBeUndefined();
  });
});

describe('isAnomalousStatus', () => {
  it('flags problem states', () => {
    for (const v of ['failed', 'error', 'DISCONNECTED', 'stuck', 'timeout', 'stale', 'pending']) {
      expect(isAnomalousStatus(v)).toBe(true);
    }
  });
  it('does not flag healthy states', () => {
    for (const v of ['completed', 'success', 'ok', 'active', 'enabled']) {
      expect(isAnomalousStatus(v)).toBe(false);
    }
  });
});

describe('ageHoursOf', () => {
  it('computes hours since an ISO timestamp', () => {
    const now = Date.parse('2026-06-14T12:00:00Z');
    expect(ageHoursOf('2026-06-14T10:00:00Z', now)).toBeCloseTo(2, 5);
  });
  it('is NaN-safe and never negative', () => {
    expect(ageHoursOf('not-a-date', Date.now())).toBe(0);
    expect(ageHoursOf('2999-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z'))).toBe(0);
  });
});

describe('stateToEvidence', () => {
  const analysis: StateAnalysis = {
    database: 'maison-safqa',
    staleHours: 24,
    collections: [
      {
        collection: 'gaiasynclogs',
        count: 5000,
        statusField: 'status',
        statusCounts: [
          { value: 'completed', count: 4900 },
          { value: 'failed', count: 100 },
        ],
        anomalies: [{ value: 'failed', count: 100 }],
      },
      {
        collection: 'scheduleconfigs',
        count: 40,
        dateField: 'last_executed_at',
        lastActivity: '2026-06-10T00:00:00Z',
        ageHours: 100,
        isStale: true,
        anomalies: [],
      },
      {
        collection: 'orders',
        count: 12000,
        anomalies: [],
      },
    ],
  };

  it('emits one Evidence per anomaly + per stale collection, none for healthy', () => {
    const ev = stateToEvidence(analysis, 'q', '2026-06-14T00:00:00Z');
    expect(ev).toHaveLength(2); // 1 failed-status + 1 stale; orders contributes nothing

    const anomaly = ev.find((e) => e.title.includes('failed'));
    expect(anomaly?.source).toBe('state');
    expect(anomaly?.kind).toBe('state');
    expect(anomaly?.relevance).toBe(0.85);
    expect(anomaly?.title).toContain('gaiasynclogs');
    expect(anomaly?.title).toContain('100');

    const stale = ev.find((e) => e.title.includes('stale'));
    expect(stale?.relevance).toBe(0.8);
    expect(stale?.title).toContain('scheduleconfigs');
    expect(stale?.timestamp).toBe('2026-06-10T00:00:00Z');
  });

  it('produces no evidence for an all-healthy analysis', () => {
    const healthy: StateAnalysis = {
      database: 'x',
      staleHours: 24,
      collections: [{ collection: 'orders', count: 1, anomalies: [] }],
    };
    expect(stateToEvidence(healthy, 'q', 't')).toEqual([]);
  });
});
