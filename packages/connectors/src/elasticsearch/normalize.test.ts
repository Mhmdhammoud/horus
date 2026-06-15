/**
 * Pure unit tests for normalize.ts (HOR-10, HOR-47). No network — no I/O of any kind.
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
  validateFieldMapping,
  getField,
  MERITT_FIELD_MAPPING,
  ECS_FIELD_MAPPING,
  type ElasticsearchFieldMapping,
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
// getField
// ---------------------------------------------------------------------------

describe('getField', () => {
  it('returns a top-level flattened key directly', () => {
    expect(getField({ service_name: 'api' }, 'service_name')).toBe('api');
  });

  it('returns @timestamp (special flattened key)', () => {
    const src = { '@timestamp': '2026-06-13T12:00:00Z' };
    expect(getField(src, '@timestamp')).toBe('2026-06-13T12:00:00Z');
  });

  it('resolves a dotted path from nested ECS objects', () => {
    const src = { service: { name: 'my-svc' }, log: { level: 'error' } };
    expect(getField(src, 'service.name')).toBe('my-svc');
    expect(getField(src, 'log.level')).toBe('error');
  });

  it('resolves deeply nested paths', () => {
    const src = { http: { request: { id: 'req-123' } } };
    expect(getField(src, 'http.request.id')).toBe('req-123');
  });

  it('prefers literal key over dotted navigation for pre-flattened ECS', () => {
    // Some ingest pipelines store "service.name" as a literal flat key
    const src = { 'service.name': 'flat-svc', service: { name: 'nested-svc' } };
    // hasOwnProperty check: literal key wins
    expect(getField(src, 'service.name')).toBe('flat-svc');
  });

  it('returns undefined for a missing path', () => {
    expect(getField({}, 'log.level')).toBeUndefined();
  });

  it('returns undefined when intermediate node is not an object', () => {
    expect(getField({ log: 'string' }, 'log.level')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateFieldMapping
// ---------------------------------------------------------------------------

describe('validateFieldMapping', () => {
  it('accepts MERITT_FIELD_MAPPING without throwing', () => {
    expect(() => validateFieldMapping(MERITT_FIELD_MAPPING)).not.toThrow();
  });

  it('accepts ECS_FIELD_MAPPING without throwing', () => {
    expect(() => validateFieldMapping(ECS_FIELD_MAPPING)).not.toThrow();
  });

  it('throws when timestampField is empty', () => {
    expect(() =>
      validateFieldMapping({ ...MERITT_FIELD_MAPPING, timestampField: '' }),
    ).toThrow(/timestampField/);
  });

  it('throws when levelField is empty', () => {
    expect(() =>
      validateFieldMapping({ ...MERITT_FIELD_MAPPING, levelField: '' }),
    ).toThrow(/levelField/);
  });

  it('throws when serviceField is empty', () => {
    expect(() =>
      validateFieldMapping({ ...MERITT_FIELD_MAPPING, serviceField: '' }),
    ).toThrow(/serviceField/);
  });

  it('throws when messageField is empty', () => {
    expect(() =>
      validateFieldMapping({ ...MERITT_FIELD_MAPPING, messageField: '' }),
    ).toThrow(/messageField/);
  });

  it('throws when eventCodeField is empty', () => {
    expect(() =>
      validateFieldMapping({ ...MERITT_FIELD_MAPPING, eventCodeField: '' }),
    ).toThrow(/eventCodeField/);
  });
});

// ---------------------------------------------------------------------------
// buildSearchBody — Meritt (default)
// ---------------------------------------------------------------------------

describe('buildSearchBody (Meritt mapping)', () => {
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

    // 3 filters: level range, time range, service term
    expect(filters).toHaveLength(3);

    // Level range filter >= 50 on 'level' field
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

    // Time range filter on 'time' field
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

    // Service term filter on 'service_name.keyword'
    const termFilter = filters.find(
      (f) => typeof f === 'object' && f !== null && 'term' in f,
    ) as Record<string, unknown> | undefined;
    expect(termFilter).toBeDefined();
    const termClause = termFilter!['term'] as Record<string, unknown>;
    expect(termClause['service_name.keyword']).toBe('leadcall-api-prod');

    // must has a match on 'message'
    expect(must).toHaveLength(1);
    const matchClause = (must[0] as Record<string, unknown>)['match'] as Record<string, unknown>;
    expect(matchClause['message']).toBe('timeout');

    // sort on 'time' desc
    const sort = body['sort'] as Array<Record<string, unknown>>;
    expect(sort[0]).toEqual({ time: { order: 'desc' } });

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
// buildSearchBody — ECS mapping
// ---------------------------------------------------------------------------

describe('buildSearchBody (ECS mapping)', () => {
  it('uses @timestamp for time range', () => {
    const body = buildSearchBody(
      { from: '2026-06-13T00:00:00Z', to: '2026-06-14T00:00:00Z' },
      ECS_FIELD_MAPPING,
    );
    const filters = (
      (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];

    const tsFilter = filters.find(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        'range' in f &&
        '@timestamp' in ((f as Record<string, unknown>)['range'] as Record<string, unknown>),
    );
    expect(tsFilter).toBeDefined();
  });

  it('uses terms filter (not range) for string log level', () => {
    const body = buildSearchBody({ level: 'error' }, ECS_FIELD_MAPPING);
    const filters = (
      (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];

    const levelFilter = filters.find(
      (f) => typeof f === 'object' && f !== null && 'terms' in f,
    ) as Record<string, unknown> | undefined;
    expect(levelFilter).toBeDefined();
    const termsClause = levelFilter!['terms'] as Record<string, unknown>;
    // log.level is the ECS level field
    expect(termsClause['log.level']).toEqual(expect.arrayContaining(['error', 'fatal']));
    // must not include levels below error
    expect((termsClause['log.level'] as string[])).not.toContain('info');
    expect((termsClause['log.level'] as string[])).not.toContain('debug');
  });

  it('uses service.name (no .keyword suffix) for service term filter', () => {
    const body = buildSearchBody({ service: 'my-svc' }, ECS_FIELD_MAPPING);
    const filters = (
      (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];

    const termFilter = filters.find(
      (f) => typeof f === 'object' && f !== null && 'term' in f,
    ) as Record<string, unknown> | undefined;
    expect(termFilter).toBeDefined();
    const termClause = termFilter!['term'] as Record<string, unknown>;
    // ECS service.name is already keyword-typed — no .keyword sub-field
    expect(termClause['service.name']).toBe('my-svc');
    expect(termClause['service.name.keyword']).toBeUndefined();
  });

  it('sorts by @timestamp', () => {
    const body = buildSearchBody({}, ECS_FIELD_MAPPING);
    const sort = body['sort'] as Array<Record<string, unknown>>;
    expect(sort[0]).toEqual({ '@timestamp': { order: 'desc' } });
  });
});

// ---------------------------------------------------------------------------
// buildSearchBody — custom timestamp field
// ---------------------------------------------------------------------------

describe('buildSearchBody (custom timestamp field)', () => {
  const customMapping: ElasticsearchFieldMapping = {
    ...MERITT_FIELD_MAPPING,
    timestampField: 'timestamp',
  };

  it('uses configured timestamp field in range filter', () => {
    const body = buildSearchBody({ from: '2026-01-01T00:00:00Z' }, customMapping);
    const filters = (
      (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];

    const tsFilter = filters.find(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        'range' in f &&
        'timestamp' in ((f as Record<string, unknown>)['range'] as Record<string, unknown>),
    );
    expect(tsFilter).toBeDefined();
  });

  it('sorts by the configured timestamp field', () => {
    const body = buildSearchBody({}, customMapping);
    const sort = body['sort'] as Array<Record<string, unknown>>;
    expect(sort[0]).toEqual({ timestamp: { order: 'desc' } });
  });
});

// ---------------------------------------------------------------------------
// buildErrorAggBody
// ---------------------------------------------------------------------------

describe('buildErrorAggBody (Meritt mapping)', () => {
  it('forces level >= 50 and aggregates on event_code.keyword', () => {
    const body = buildErrorAggBody({ service: 'leadcall-api-prod' }, 'event_code');

    expect(body['size']).toBe(0);

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
    expect(levelFilter).toBeDefined();
    const levelRange = (levelFilter!['range'] as Record<string, unknown>)['level'] as Record<string, unknown>;
    expect(levelRange['gte']).toBe(50);

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

describe('buildErrorAggBody (ECS mapping)', () => {
  it('uses string terms filter for ECS level', () => {
    const body = buildErrorAggBody({}, 'event.code', ECS_FIELD_MAPPING);
    const filters = (
      (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];

    const levelFilter = filters.find(
      (f) => typeof f === 'object' && f !== null && 'terms' in f,
    ) as Record<string, unknown> | undefined;
    expect(levelFilter).toBeDefined();
    const terms = levelFilter!['terms'] as Record<string, unknown>;
    expect(terms['log.level']).toEqual(expect.arrayContaining(['error', 'fatal']));
  });

  it('uses @timestamp for time range', () => {
    const body = buildErrorAggBody(
      { from: '2026-06-13T00:00:00Z' },
      'event.code',
      ECS_FIELD_MAPPING,
    );
    const filters = (
      (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];

    const tsFilter = filters.find(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        'range' in f &&
        '@timestamp' in ((f as Record<string, unknown>)['range'] as Record<string, unknown>),
    );
    expect(tsFilter).toBeDefined();
  });

  it('uses service.name (no .keyword suffix) for service term filter', () => {
    const body = buildErrorAggBody({ service: 'my-svc' }, 'event.code', ECS_FIELD_MAPPING);
    const filters = (
      (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];

    const termFilter = filters.find(
      (f) => typeof f === 'object' && f !== null && 'term' in f,
    ) as Record<string, unknown> | undefined;
    // ECS service.name is already keyword-typed
    expect((termFilter!['term'] as Record<string, unknown>)['service.name']).toBe('my-svc');
    expect((termFilter!['term'] as Record<string, unknown>)['service.name.keyword']).toBeUndefined();
  });

  it('uses event.code directly (no .keyword suffix) for aggregation field', () => {
    const body = buildErrorAggBody({}, 'event.code', ECS_FIELD_MAPPING);
    const aggs = body['aggs'] as Record<string, unknown>;
    const terms = (aggs['by_key'] as Record<string, unknown>)['terms'] as Record<string, unknown>;
    // ECS event.code is already keyword-typed
    expect(terms['field']).toBe('event.code');
    expect(terms['field']).not.toBe('event.code.keyword');
  });
});

// ---------------------------------------------------------------------------
// normalizeHit
// ---------------------------------------------------------------------------

const merrittHit = {
  _index: 'leadcall-api-prod-2026-06-13',
  _source: {
    time: '2026-06-13T12:00:00.000Z',
    level: 50,
    log_level: 'error',
    message: 'boom',
    service_name: 'leadcall-api-prod',
    component: 'HttpExceptionLoggingFilter',
    event_code: 'HTTPFLT001',
    trace_id: 'trace-abc-123',
  },
};

describe('normalizeHit (Meritt mapping)', () => {
  it('normalizes a Meritt hit correctly', () => {
    const record = normalizeHit(merrittHit);
    expect(record.level).toBe('error');
    expect(record.levelValue).toBe(50);
    expect(record.message).toBe('boom');
    expect(record.service).toBe('leadcall-api-prod');
    expect(record.component).toBe('HttpExceptionLoggingFilter');
    expect(record.eventCode).toBe('HTTPFLT001');
    expect(record.index).toBe('leadcall-api-prod-2026-06-13');
    expect(record.timestamp).toBe('2026-06-13T12:00:00.000Z');
  });

  it('extracts trace_id from the top-level field', () => {
    const record = normalizeHit(merrittHit);
    expect(record.traceId).toBe('trace-abc-123');
  });

  it('falls back to msg field for message', () => {
    const hit = { _index: 'idx', _source: { level: 30, msg: 'hello world' } };
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
    const hit = { _index: 'idx', _source: { log_level: 'warn', message: 'test' } };
    const record = normalizeHit(hit);
    expect(record.level).toBe('warn');
    expect(record.levelValue).toBe(40);
  });

  it('extracts traceId from parseable context JSON when no top-level trace_id', () => {
    const hit = {
      _index: 'idx',
      _source: {
        level: 50,
        message: 'traced error',
        context: JSON.stringify({ traceId: 'abc-123' }),
      },
    };
    const record = normalizeHit(hit, { ...MERITT_FIELD_MAPPING, traceIdField: undefined });
    expect(record.traceId).toBe('abc-123');
  });

  it('prefers top-level trace_id over context JSON', () => {
    const hit = {
      _index: 'idx',
      _source: {
        level: 50,
        message: 'err',
        trace_id: 'top-level-id',
        context: JSON.stringify({ traceId: 'json-id' }),
      },
    };
    const record = normalizeHit(hit);
    expect(record.traceId).toBe('top-level-id');
  });

  it('leaves traceId undefined when context is not parseable and no top-level field', () => {
    const hit = {
      _index: 'idx',
      _source: { level: 50, message: 'err', context: 'not-json' },
    };
    const record = normalizeHit(hit, { ...MERITT_FIELD_MAPPING, traceIdField: undefined });
    expect(record.traceId).toBeUndefined();
  });
});

describe('normalizeHit (ECS mapping — pre-flattened _source)', () => {
  // Some ingest pipelines store dotted ECS fields as literal flat keys.
  const ecsHitFlat = {
    _index: 'logs-app-2026-06-13',
    _source: {
      '@timestamp': '2026-06-13T12:00:00.000Z',
      'log.level': 'error',
      message: 'ecs error flat',
      'service.name': 'my-ecs-svc',
      'event.code': 'ERR001',
      'trace.id': 'ecs-trace-xyz',
    },
  };

  it('extracts all fields from pre-flattened ECS _source', () => {
    const record = normalizeHit(ecsHitFlat, ECS_FIELD_MAPPING);
    expect(record.timestamp).toBe('2026-06-13T12:00:00.000Z');
    expect(record.level).toBe('error');
    expect(record.levelValue).toBe(50);
    expect(record.message).toBe('ecs error flat');
    expect(record.service).toBe('my-ecs-svc');
    expect(record.eventCode).toBe('ERR001');
    expect(record.traceId).toBe('ecs-trace-xyz');
  });
});

describe('normalizeHit (ECS mapping — nested _source)', () => {
  // Standard ECS documents from Filebeat/APM have nested object structure.
  const ecsHitNested = {
    _index: 'logs-app-2026-06-13',
    _source: {
      '@timestamp': '2026-06-13T12:00:00.000Z',
      log: { level: 'error' },
      message: 'ecs error nested',
      service: { name: 'my-ecs-svc' },
      event: { code: 'ERR001' },
      trace: { id: 'ecs-trace-xyz' },
      http: { request: { id: 'req-456' } },
    },
  };

  it('extracts timestamp from @timestamp', () => {
    const record = normalizeHit(ecsHitNested, ECS_FIELD_MAPPING);
    expect(record.timestamp).toBe('2026-06-13T12:00:00.000Z');
  });

  it('resolves log.level from nested object', () => {
    const record = normalizeHit(ecsHitNested, ECS_FIELD_MAPPING);
    expect(record.level).toBe('error');
    expect(record.levelValue).toBe(50);
  });

  it('resolves service.name from nested object', () => {
    const record = normalizeHit(ecsHitNested, ECS_FIELD_MAPPING);
    expect(record.service).toBe('my-ecs-svc');
  });

  it('resolves event.code from nested object', () => {
    const record = normalizeHit(ecsHitNested, ECS_FIELD_MAPPING);
    expect(record.eventCode).toBe('ERR001');
  });

  it('resolves trace.id from nested object', () => {
    const record = normalizeHit(ecsHitNested, ECS_FIELD_MAPPING);
    expect(record.traceId).toBe('ecs-trace-xyz');
  });

  it('resolves http.request.id from deeply nested object', () => {
    const record = normalizeHit(ecsHitNested, ECS_FIELD_MAPPING);
    expect(record.requestId).toBe('req-456');
  });
});

describe('normalizeHit (legacy service_name without .keyword)', () => {
  const customMapping: ElasticsearchFieldMapping = {
    ...MERITT_FIELD_MAPPING,
    serviceField: 'service_name',
    serviceKeyword: false,
  };

  it('reads service from the configured field', () => {
    const hit = { _index: 'idx', _source: { time: '2026-01-01T00:00:00Z', level: 30, message: 'hi', service_name: 'svc-a' } };
    const record = normalizeHit(hit, customMapping);
    expect(record.service).toBe('svc-a');
  });
});

// ---------------------------------------------------------------------------
// hitsToRecords
// ---------------------------------------------------------------------------

describe('hitsToRecords', () => {
  it('maps an ES search response to LogRecord[]', () => {
    const response = { hits: { hits: [merrittHit] } };
    const records = hitsToRecords(response);
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('error');
    expect(records[0]?.traceId).toBe('trace-abc-123');
  });

  it('passes the mapping through to normalizeHit (ECS)', () => {
    const ecsHit = {
      _index: 'idx',
      _source: {
        '@timestamp': '2026-06-13T10:00:00Z',
        'log.level': 'warn',
        message: 'ecs warn',
        'service.name': 'svc-b',
      },
    };
    const records = hitsToRecords({ hits: { hits: [ecsHit] } }, ECS_FIELD_MAPPING);
    expect(records[0]?.timestamp).toBe('2026-06-13T10:00:00Z');
    expect(records[0]?.level).toBe('warn');
    expect(records[0]?.service).toBe('svc-b');
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

    const a = deltas.find((d) => d.key === 'A');
    expect(a).toBeDefined();
    expect(a!.delta).toBe(4);
    expect(a!.ratio).toBe(3);
    expect(a!.baseline).toBe(2);
    expect(a!.current).toBe(6);

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
    const records = hitsToRecords({ hits: { hits: [merrittHit] } });
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

  it('surfaces traceId in links when extracted by normalizeHit', () => {
    const records = hitsToRecords({ hits: { hits: [merrittHit] } });
    const evidence = logsToEvidence(records, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]!.links.traceId).toBe('trace-abc-123');
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

  it('extracts traceId from parseable context JSON (legacy path)', () => {
    const hitWithContext = {
      _index: 'idx',
      _source: {
        level: 50,
        message: 'traced error',
        context: JSON.stringify({ traceId: 'abc-123' }),
      },
    };
    // Use mapping without traceIdField so context-JSON fallback is exercised.
    const records = hitsToRecords(
      { hits: { hits: [hitWithContext] } },
      { ...MERITT_FIELD_MAPPING, traceIdField: undefined },
    );
    const evidence = logsToEvidence(records, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]!.links.traceId).toBe('abc-123');
  });

  it('leaves traceId undefined when context is not parseable', () => {
    const hitBadCtx = {
      _index: 'idx',
      _source: { level: 50, message: 'err', context: 'not-json' },
    };
    const records = hitsToRecords(
      { hits: { hits: [hitBadCtx] } },
      { ...MERITT_FIELD_MAPPING, traceIdField: undefined },
    );
    const evidence = logsToEvidence(records, 'q', '2026-06-14T00:00:00Z');
    expect(evidence[0]!.links.traceId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-path consistency: same mapping drives both buildSearchBody and
// buildErrorAggBody (HOR-47 requirement)
// ---------------------------------------------------------------------------

describe('field mapping consistency across query builders', () => {
  const customMapping: ElasticsearchFieldMapping = {
    timestampField: 'ts',
    levelField: 'severity',
    levelFormat: 'string',
    serviceField: 'app',
    serviceKeyword: false,
    messageField: 'msg_text',
    eventCodeField: 'error_type',
    eventCodeKeyword: false,
  };

  it('buildSearchBody and buildErrorAggBody use the same timestamp field', () => {
    const searchBody = buildSearchBody({ from: '2026-01-01T00:00:00Z' }, customMapping);
    const aggBody = buildErrorAggBody({ from: '2026-01-01T00:00:00Z' }, 'error_type', customMapping);

    const searchFilters = (
      (searchBody['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];
    const aggFilters = (
      (aggBody['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];

    const hasTsFilter = (filters: unknown[]) =>
      filters.some(
        (f) =>
          typeof f === 'object' &&
          f !== null &&
          'range' in f &&
          'ts' in ((f as Record<string, unknown>)['range'] as Record<string, unknown>),
      );

    expect(hasTsFilter(searchFilters)).toBe(true);
    expect(hasTsFilter(aggFilters)).toBe(true);
  });

  it('buildSearchBody and buildErrorAggBody use the same service field', () => {
    const searchBody = buildSearchBody({ service: 'my-app' }, customMapping);
    const aggBody = buildErrorAggBody({ service: 'my-app' }, 'error_type', customMapping);

    const termIn = (filters: unknown[]) =>
      filters.find(
        (f) => typeof f === 'object' && f !== null && 'term' in f,
      ) as Record<string, unknown> | undefined;

    const searchFilters = (
      (searchBody['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];
    const aggFilters = (
      (aggBody['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    )['filter'] as unknown[];

    // serviceKeyword is false, so 'app' (not 'app.keyword')
    expect((termIn(searchFilters)!['term'] as Record<string, unknown>)['app']).toBe('my-app');
    expect((termIn(aggFilters)!['term'] as Record<string, unknown>)['app']).toBe('my-app');
  });
});
