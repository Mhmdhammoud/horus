import { describe, it, expect } from 'vitest';
import {
  pickField,
  isAnomalousStatus,
  ageHoursOf,
  classifyAge,
  tokenize,
  collectionMatchesTerms,
  selectStateSignals,
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

describe('classifyAge', () => {
  it('classifies by age against stale/legacy horizons', () => {
    expect(classifyAge(2, 24, 2160)).toBe('active');
    expect(classifyAge(100, 24, 2160)).toBe('stale');
    expect(classifyAge(5000, 24, 2160)).toBe('legacy');
    expect(classifyAge(undefined, 24, 2160)).toBe('unknown');
  });
});

describe('tokenize / collectionMatchesTerms', () => {
  it('tokenizes camelCase + words, length >= 4', () => {
    expect(tokenize('inferSupplierScopeFromLegacyOrder')).toEqual(
      expect.arrayContaining(['infer', 'supplier', 'scope', 'from', 'legacy', 'order']),
    );
    expect(tokenize('orders are slow')).toEqual(expect.arrayContaining(['orders', 'slow']));
  });
  it('matches collections to terms (singular-aware), all-relevant with no terms', () => {
    expect(collectionMatchesTerms('orders', ['order'])).toBe(true);
    expect(collectionMatchesTerms('suppliers', ['supplier'])).toBe(true);
    expect(collectionMatchesTerms('users', ['order', 'supplier', 'slow'])).toBe(false);
    expect(collectionMatchesTerms('anything', [])).toBe(true);
  });
});

// Mimics the maison "orders are slow" run: order/supplier-related seed terms.
const ANALYSIS: StateAnalysis = {
  database: 'maison-safqa',
  staleHours: 24,
  legacyHours: 2160,
  collections: [
    {
      collection: 'gaiasynclogs', // legacy + failed, unrelated to orders
      count: 5000,
      classification: 'legacy',
      statusField: 'status',
      anomalies: [{ value: 'failed', count: 420 }],
    },
    {
      collection: 'users', // legacy stale, unrelated
      count: 2,
      classification: 'legacy',
      dateField: 'updatedAt',
      lastActivity: '2024-12-27T15:34:00Z',
      ageHours: 12800,
      isStale: true,
      anomalies: [],
    },
    {
      collection: 'suppliers', // stale, RELATED (supplier term)
      count: 1,
      classification: 'stale',
      dateField: 'updatedAt',
      lastActivity: '2026-05-29T22:40:39Z',
      ageHours: 373,
      isStale: true,
      anomalies: [],
    },
    {
      collection: 'orders', // active failing, RELATED
      count: 12000,
      classification: 'active',
      statusField: 'status',
      ageHours: 1,
      anomalies: [{ value: 'stuck', count: 7 }],
    },
  ],
};

describe('selectStateSignals (relevance discipline)', () => {
  const terms = ['order', 'orders', 'supplier', 'scope', 'slow'];

  it('drops unrelated legacy/stale collections, keeps related ones', () => {
    const sig = selectStateSignals(ANALYSIS, terms);
    const cols = sig.map((s) => s.collection);
    expect(cols).toContain('orders'); // active + related
    expect(cols).toContain('suppliers'); // stale + related
    expect(cols).not.toContain('users'); // legacy + unrelated -> dropped
    // gaiasynclogs is legacy + unrelated -> its 'failed' anomaly is dropped
    expect(cols).not.toContain('gaiasynclogs');
  });

  it('ranks the related active anomaly highest', () => {
    const sig = selectStateSignals(ANALYSIS, terms);
    expect(sig[0]?.collection).toBe('orders');
    expect(sig[0]?.relevance).toBe(0.85);
  });

  it('with no terms, keeps active anomalies but still drops unrelated stale (none related)', () => {
    const sig = selectStateSignals(ANALYSIS, []);
    // Every collection is "relevant" with no terms; anomalies for orders + gaiasynclogs,
    // stale for users + suppliers. Legacy ones are down-weighted to 0.25.
    const orders = sig.find((s) => s.collection === 'orders');
    const legacy = sig.find((s) => s.collection === 'gaiasynclogs');
    expect(orders?.relevance).toBe(0.85);
    expect(legacy?.relevance).toBe(0.25);
  });
});

describe('stateToEvidence', () => {
  it('maps selected signals to state Evidence', () => {
    const ev = stateToEvidence(ANALYSIS, 'orders are slow', '2026-06-14T00:00:00Z', [
      'order',
      'supplier',
    ]);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.source === 'state' && e.kind === 'state')).toBe(true);
    expect(ev.some((e) => e.title.includes('orders'))).toBe(true);
    expect(ev.some((e) => e.title.includes('users'))).toBe(false); // unrelated legacy dropped
  });
});
