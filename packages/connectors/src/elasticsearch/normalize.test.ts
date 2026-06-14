/**
 * Pure unit tests for normalize.ts (HOR-10). No network — no I/O of any kind.
 */

import { describe, it, expect } from 'vitest';
import {
  valueToLevel,
  levelToValue,
  buildSearchBody,
  buildErrorAggBody,
  normalizeHit,
  hitsToRecords,
  aggToErrorBuckets,
  computeErrorDeltas,
  logsToEvidence,
} from './normalize.js';

// ---------------------------------------------------------------------------
// valueToLevel / levelToValue
// ---------------------------------------------------------------------------

describe('valueToLevel', () => {
  it('maps 50 -> error', () => {
    expect(valueToLevel(50)).toBe('error');
  });

  it('maps 30 -> info', () => {
    expect(valueToLevel(30)).toBe('info');
  });

  it('maps 60 -> fatal', () => {
    expect(valueToLevel(60)).toBe('fatal');
  });

  it('maps 5 -> trace (below 10)', () => {
    expect(valueToLevel(5)).toBe('trace');
  });

  it('maps 40 -> warn', () => {
    expect(valueToLevel(40)).toBe('warn');
  });

  it('maps 65 -> fatal (above 60)', () => {
    expect(valueToLevel(65)).toBe('fatal');
  });

  it('maps 20 -> debug', () => {
    expect(valueToLevel(20)).toBe('debug');
  });
});

describe('levelToValue', () => {
  it('error -> 50', () => {
    expect(levelToValue('error')).toBe(50);
  });

  it('info -> 30', () => {
    expect(levelToValue('info')).toBe(30);
  });

  it('fatal -> 60', () => {
    expect(levelToValue('fatal')).toBe(60);
  });

  it('trace -> 10', () => {
    expect(levelToValue('trace')).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// buildSearchBody
// ---------------------------------------------------------------------------

describe('buildSearchBody', () => {
  it('builds a full query with all parameters', () => {
    const body = buildSearchBody({
      service: 'leadcall-api-prod',
      level: 'error',
      from: '2026-06-13T00:00:00Z',
      text: 'timeout',
      limit: 10,
    });

    const q = body['query'] as Record<string, unknown>;
    const bool = q['bool'] as Record<string, unknown>;
    const filters = bool['filter'] as unknown[];
    const must = bool['must'] as unknown[];

    // Should have 3 filters: level range, time range, service term
    expect(filters).toHaveLength(3);

    // Level range filter >= 50
    const levelFilter = filters.find(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        'range' in f &&
        'level' in ((f as Record<string, unknown>)['range'] as Record<string, unknown>),
    ) as Record<string, unknown> | undefined;
    expect(levelFilter).toBeDefined();
    const levelRange = (levelFilter!['range'] as Record<string, unknown>)['level'] as Record<string, unknown>;
    expect(levelRange['gte']).toBe(50);

    // Time range filter
    const timeFilter = filters.find(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        'range' in f &&
        'time' in ((f as Record<string, unknown>)['range'] as Record<string, unknown>),
    ) as Record<string, unknown> | undefined;
    expect(timeFilter).toBeDefined();
    const timeRange = (timeFilter!['range'] as Record<string, unknown>)['time'] as Record<string, unknown>;
    expect(timeRange['gte']).toBe('2026-06-13T00:00:00Z');

    // Service term filter
    const termFilter = filters.find(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        'term' in f,
    ) as Record<string, unknown> | undefined;
    expect(termFilter).toBeDefined();
    const termClause = termFilter!['term'] as Record<string, unknown>;
    expect(termClause['service_name.keyword']).toBe('leadcall-api-prod');

    // must has a match on message
    expect(must).toHaveLength(1);
    const matchClause = (must[0] as Record<string, unknown>)['match'] as Record<string, unknown>;
    expect(matchClause['message']).toBe('timeout');

    // sort on time desc
    const sort = body['sort'] as Array<Record<string, unknown>>;
    expect(sort[0]).toEqual({ time: { order: 'desc' } });

    // size
    expect(body['size']).toBe(10);
  });

  it('uses match_all when no text is provided', () => {
    const body = buildSearchBody({});
    const q = body['query'] as Record<string, unknown>;
    const bool = q['bool'] as Record<string, unknown>;
    const must = bool['must'] as unknown[];
    expect(must[0]).toEqual({ match_all: {} });
  });

  it('defaults size to 50', () => {
    const body = buildSearchBody({});
    expect(body['size']).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// buildErrorAggBody
// ---------------------------------------------------------------------------

describe('buildErrorAggBody', () => {
  it('forces level >= 50 and aggregates on event_code.keyword', () => {
    const body = buildErrorAggBody({ service: 'leadcall-api-prod' }, 'event_code');

    expect(body['size']).toBe(0);

    const q = body['query'] as Record<string, unknown>;
    const bool = q['bool'] as Record<string, unknown>;
    const filters = bool['filter'] as unknown[];

    // Must contain a level >= 50 range filter
    const levelFilter = filters.find(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        'range' in f &&
        'level' in ((f as Record<string, unknown>)['range'] as Record<string, unknown>),
    ) as Record<string, unknown> | undefined;
    expect(levelFilter).toBeDefined();
    const levelRange = (levelFilter!['range'] as Record<string, unknown>)['level'] as Record<string, unknown>;
    expect(levelRange['gte']).toBe(50);

    // Aggs on event_code.keyword
    const aggs = body['aggs'] as Record<string, unknown>;
    const byKey = aggs['by_key'] as Record<string, unknown>;
    const terms = byKey['terms'] as Record<string, unknown>;
    expect(terms['field']).toBe('event_code.keyword');
  });

  it('uses a higher minimum level when q.level is fatal (60)', () => {
    const body = buildErrorAggBody({ level: 'fatal' }, 'event_code');
    const q = body['query'] as Record<string, unknown>;
    const bool = q['bool'] as Record<string, unknown>;
    const filters = bool['filter'] as unknown[];
    const levelFilter = filters.find(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        'range' in f &&
        'level' in ((f as Record<string, unknown>)['range'] as Record<string, unknown>),
    ) as Record<string, unknown> | undefined;
    const levelRange = (levelFilter!['range'] as Record<string, unknown>)['level'] as Record<string, unknown>;
    expect(levelRange['gte']).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// normalizeHit
// ---------------------------------------------------------------------------

const pinoHit = {
  _index: 'leadcall-api-prod-2026-06-13',
  _source: {
    time: '2026-06-13T12:00:00.000Z',
    level: 50,
    message: 'boom',
    service_name: 'leadcall-api-prod',
    component: 'HttpExceptionLoggingFilter',
    event_code: 'HTTPFLT001',
  },
};

describe('normalizeHit', () => {
  it('normalizes a pino hit correctly', () => {
    const record = normalizeHit(pinoHit);
    expect(record.level).toBe('error');
    expect(record.levelValue).toBe(50);
    expect(record.message).toBe('boom');
    expect(record.service).toBe('leadcall-api-prod');
    expect(record.component).toBe('HttpExceptionLoggingFilter');
    expect(record.eventCode).toBe('HTTPFLT001');
    expect(record.index).toBe('leadcall-api-prod-2026-06-13');
    expect(record.timestamp).toBe('2026-06-13T12:00:00.000Z');
  });

  it('falls back to msg field for message', () => {
    const hit = {
      _index: 'idx',
      _source: { level: 30, msg: 'hello world' },
    };
    const record = normalizeHit(hit);
    expect(record.message).toBe('hello world');
    expect(record.level).toBe('info');
  });

  it('handles missing _source gracefully', () => {
    const hit = { _index: 'idx' };
    const record = normalizeHit(hit);
    expect(record.message).toBe('');
    expect(record.level).toBe('info'); // default 30
    expect(record.index).toBe('idx');
  });

  it('uses log_level string when level is not a number', () => {
    const hit = {
      _index: 'idx',
      _source: { log_level: 'warn', message: 'test' },
    };
    const record = normalizeHit(hit);
    expect(record.level).toBe('warn');
    expect(record.levelValue).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// hitsToRecords
// ---------------------------------------------------------------------------

describe('hitsToRecords', () => {
  it('maps an ES search response to LogRecord[]', () => {
    const response = { hits: { hits: [pinoHit] } };
    const records = hitsToRecords(response);
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('error');
  });

  it('returns [] for empty hits', () => {
    expect(hitsToRecords({ hits: { hits: [] } })).toEqual([]);
  });

  it('returns [] when hits is missing', () => {
    expect(hitsToRecords({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// aggToErrorBuckets
// ---------------------------------------------------------------------------

const aggResponse = {
  aggregations: {
    by_key: {
      buckets: [
        { key: 'HTTPFLT001', doc_count: 438 },
        { key: 'DB001', doc_count: 12 },
      ],
    },
  },
};

describe('aggToErrorBuckets', () => {
  it('converts aggregation response to ErrorBucket[]', () => {
    const buckets = aggToErrorBuckets(aggResponse);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toEqual({ key: 'HTTPFLT001', count: 438 });
    expect(buckets[1]).toEqual({ key: 'DB001', count: 12 });
  });

  it('returns [] when aggregations missing', () => {
    expect(aggToErrorBuckets({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeErrorDeltas
// ---------------------------------------------------------------------------

describe('computeErrorDeltas', () => {
  it('computes correct deltas, ratios, and sorts by delta desc', () => {
    const baseline = [{ key: 'A', count: 2 }];
    const current = [
      { key: 'A', count: 6 },
      { key: 'B', count: 3 },
    ];

    const deltas = computeErrorDeltas(baseline, current);
    expect(deltas).toHaveLength(2);

    // A: delta 4, ratio 3
    const a = deltas.find((d) => d.key === 'A');
    expect(a).toBeDefined();
    expect(a!.delta).toBe(4);
    expect(a!.ratio).toBe(3);
    expect(a!.baseline).toBe(2);
    expect(a!.current).toBe(6);

    // B: baseline 0, current 3, ratio Infinity
    const b = deltas.find((d) => d.key === 'B');
    expect(b).toBeDefined();
    expect(b!.baseline).toBe(0);
    expect(b!.current).toBe(3);
    expect(b!.delta).toBe(3);
    expect(b!.ratio).toBe(Infinity);

    // Sorted by delta desc: A(4) then B(3)
    expect(deltas[0]!.key).toBe('A');
    expect(deltas[1]!.key).toBe('B');
  });

  it('returns ratio 0 when both baseline and current are 0', () => {
    const deltas = computeErrorDeltas([{ key: 'X', count: 0 }], [{ key: 'X', count: 0 }]);
    expect(deltas[0]!.ratio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// logsToEvidence
// ---------------------------------------------------------------------------

describe('logsToEvidence', () => {
  it('produces correct Evidence items for error-level logs', () => {
    const records = hitsToRecords({ hits: { hits: [pinoHit] } });
    const evidence = logsToEvidence(records, 'test-query', '2026-06-14T00:00:00Z');

    expect(evidence).toHaveLength(1);
    const ev = evidence[0]!;
    expect(ev.source).toBe('logs');
    expect(ev.kind).toBe('log');
    expect(ev.relevance).toBe(0.9); // error
    expect(ev.provenance.query).toBe('test-query');
    expect(ev.provenance.collectedAt).toBe('2026-06-14T00:00:00Z');
    expect(ev.title).toContain('[error]');
    expect(ev.title).toContain('boom');
  });

  it('assigns relevance 1.0 for fatal logs', () => {
    const fatalHit = {
      _index: 'idx',
      _source: { level: 60, message: 'crash', service_name: 'svc' },
    };
    const records = hitsToRecords({ hits: { hits: [fatalHit] } });
    const evidence = logsToEvidence(records, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]!.relevance).toBe(1);
  });

  it('assigns relevance 0.3 for info logs', () => {
    const infoHit = {
      _index: 'idx',
      _source: { level: 30, message: 'startup', service_name: 'svc' },
    };
    const records = hitsToRecords({ hits: { hits: [infoHit] } });
    const evidence = logsToEvidence(records, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]!.relevance).toBe(0.3);
  });

  it('assigns relevance 0.6 for warn logs', () => {
    const warnHit = {
      _index: 'idx',
      _source: { level: 40, message: 'slow', service_name: 'svc' },
    };
    const records = hitsToRecords({ hits: { hits: [warnHit] } });
    const evidence = logsToEvidence(records, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]!.relevance).toBe(0.6);
  });

  it('extracts traceId from parseable context JSON', () => {
    const hitWithContext = {
      _index: 'idx',
      _source: {
        level: 50,
        message: 'traced error',
        context: JSON.stringify({ traceId: 'abc-123' }),
      },
    };
    const records = hitsToRecords({ hits: { hits: [hitWithContext] } });
    const evidence = logsToEvidence(records, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]!.links.traceId).toBe('abc-123');
  });

  it('leaves traceId undefined when context is not parseable', () => {
    const hitBadCtx = {
      _index: 'idx',
      _source: { level: 50, message: 'err', context: 'not-json' },
    };
    const records = hitsToRecords({ hits: { hits: [hitBadCtx] } });
    const evidence = logsToEvidence(records, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]!.links.traceId).toBeUndefined();
  });
});
