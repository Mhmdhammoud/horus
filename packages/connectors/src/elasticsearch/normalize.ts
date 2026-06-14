/**
 * Pure normalization helpers for Elasticsearch log documents (HOR-10).
 * No I/O — all functions are exhaustively unit-testable.
 */

import type { Evidence } from '@horus/core';

// ---------------------------------------------------------------------------
// Level utilities
// ---------------------------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LEVEL_VALUE: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Map a pino numeric level to the nearest floor bucket. */
export function valueToLevel(n: number): LogLevel {
  if (n >= 60) return 'fatal';
  if (n >= 50) return 'error';
  if (n >= 40) return 'warn';
  if (n >= 30) return 'info';
  if (n >= 20) return 'debug';
  return 'trace';
}

export function levelToValue(l: LogLevel): number {
  return LEVEL_VALUE[l];
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  levelValue: number;
  message: string;
  service?: string;
  component?: string;
  eventCode?: string;
  host?: string;
  index: string;
  raw: Record<string, unknown>;
}

export interface LogQuery {
  service?: string;
  index?: string;
  from?: string;
  to?: string;
  level?: LogLevel;
  text?: string;
  limit?: number;
}

export interface ErrorBucket {
  key: string;
  count: number;
}

export interface ErrorDelta {
  key: string;
  baseline: number;
  current: number;
  delta: number;
  ratio: number;
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

export function buildSearchBody(q: LogQuery): Record<string, unknown> {
  const filters: unknown[] = [];

  if (q.level !== undefined) {
    filters.push({ range: { level: { gte: levelToValue(q.level) } } });
  }

  if (q.from !== undefined || q.to !== undefined) {
    const rangeClause: Record<string, string> = {};
    if (q.from !== undefined) rangeClause['gte'] = q.from;
    if (q.to !== undefined) rangeClause['lte'] = q.to;
    filters.push({ range: { time: rangeClause } });
  }

  if (q.service !== undefined) {
    filters.push({ term: { 'service_name.keyword': q.service } });
  }

  const mustClause: unknown[] =
    q.text !== undefined ? [{ match: { message: q.text } }] : [{ match_all: {} }];

  return {
    query: {
      bool: {
        filter: filters,
        must: mustClause,
      },
    },
    sort: [{ time: { order: 'desc' } }],
    size: q.limit ?? 50,
  };
}

export function buildErrorAggBody(q: LogQuery, field: string): Record<string, unknown> {
  const filters: unknown[] = [];

  // Force level >= error (50) unless q.level is set higher.
  const minLevel =
    q.level !== undefined && levelToValue(q.level) > 50 ? levelToValue(q.level) : 50;
  filters.push({ range: { level: { gte: minLevel } } });

  if (q.from !== undefined || q.to !== undefined) {
    const rangeClause: Record<string, string> = {};
    if (q.from !== undefined) rangeClause['gte'] = q.from;
    if (q.to !== undefined) rangeClause['lte'] = q.to;
    filters.push({ range: { time: rangeClause } });
  }

  if (q.service !== undefined) {
    filters.push({ term: { 'service_name.keyword': q.service } });
  }

  return {
    size: 0,
    query: {
      bool: {
        filter: filters,
      },
    },
    aggs: {
      by_key: {
        terms: {
          field: `${field}.keyword`,
          size: 20,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Hit normalization
// ---------------------------------------------------------------------------

export function normalizeHit(hit: unknown): LogRecord {
  const h = hit as Record<string, unknown>;
  const src = (h['_source'] ?? {}) as Record<string, unknown>;

  const timestamp =
    typeof src['time'] === 'string'
      ? src['time']
      : typeof src['@timestamp'] === 'string'
        ? src['@timestamp']
        : '';

  let levelValue: number;
  if (typeof src['level'] === 'number') {
    levelValue = src['level'];
  } else if (typeof src['log_level'] === 'string') {
    const ll = src['log_level'] as string;
    const mapped = ll.toLowerCase() as LogLevel;
    levelValue = LEVEL_VALUE[mapped] ?? 30;
  } else {
    levelValue = 30;
  }

  const level = valueToLevel(levelValue);

  const message =
    typeof src['message'] === 'string'
      ? src['message']
      : typeof src['msg'] === 'string'
        ? src['msg']
        : '';

  const service = typeof src['service_name'] === 'string' ? src['service_name'] : undefined;
  const component =
    typeof src['component'] === 'string'
      ? src['component']
      : typeof src['log_logger'] === 'string'
        ? src['log_logger']
        : undefined;
  const eventCode =
    typeof src['event_code'] === 'string'
      ? src['event_code']
      : typeof src['code'] === 'string'
        ? src['code']
        : undefined;
  const host =
    typeof src['hostname'] === 'string'
      ? src['hostname']
      : typeof src['host_name'] === 'string'
        ? src['host_name']
        : undefined;

  const index = typeof h['_index'] === 'string' ? h['_index'] : '';

  return { timestamp, level, levelValue, message, service, component, eventCode, host, index, raw: src };
}

export function hitsToRecords(searchResponse: unknown): LogRecord[] {
  const res = searchResponse as Record<string, unknown>;
  const hits = res['hits'] as Record<string, unknown> | undefined;
  const hitsArr = (hits?.['hits'] ?? []) as unknown[];
  return hitsArr.map(normalizeHit);
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

export function aggToErrorBuckets(searchResponse: unknown): ErrorBucket[] {
  const res = searchResponse as Record<string, unknown>;
  const aggs = res['aggregations'] as Record<string, unknown> | undefined;
  const byKey = aggs?.['by_key'] as Record<string, unknown> | undefined;
  const buckets = (byKey?.['buckets'] ?? []) as Array<Record<string, unknown>>;
  return buckets.map((b) => ({
    key: typeof b['key'] === 'string' ? b['key'] : String(b['key'] ?? ''),
    count: typeof b['doc_count'] === 'number' ? b['doc_count'] : 0,
  }));
}

export function computeErrorDeltas(
  baseline: ErrorBucket[],
  current: ErrorBucket[],
): ErrorDelta[] {
  const allKeys = new Set<string>();
  for (const b of baseline) allKeys.add(b.key);
  for (const c of current) allKeys.add(c.key);

  const baselineMap = new Map<string, number>(baseline.map((b) => [b.key, b.count]));
  const currentMap = new Map<string, number>(current.map((c) => [c.key, c.count]));

  const deltas: ErrorDelta[] = [];
  for (const key of allKeys) {
    const b = baselineMap.get(key) ?? 0;
    const c = currentMap.get(key) ?? 0;
    const delta = c - b;
    const ratio = b === 0 ? (c > 0 ? Infinity : 0) : c / b;
    deltas.push({ key, baseline: b, current: c, delta, ratio });
  }

  deltas.sort((a, b) => b.delta - a.delta);
  return deltas;
}

// ---------------------------------------------------------------------------
// Evidence conversion
// ---------------------------------------------------------------------------

export function logsToEvidence(
  records: LogRecord[],
  query: string,
  collectedAt: string,
): Evidence[] {
  return records.map((r, i) => {
    let traceId: string | undefined;
    const ctxRaw = r.raw['context'];
    if (typeof ctxRaw === 'string') {
      try {
        const parsed = JSON.parse(ctxRaw) as Record<string, unknown>;
        const tid = parsed['traceId'] ?? parsed['trace_id'];
        if (typeof tid === 'string') traceId = tid;
      } catch {
        // not parseable — leave undefined
      }
    }

    const componentOrService = r.component ?? r.service ?? '';
    const title = `[${r.level}] ${componentOrService}: ${r.message}`.slice(0, 160);

    const relevance =
      r.level === 'fatal'
        ? 1
        : r.level === 'error'
          ? 0.9
          : r.level === 'warn'
            ? 0.6
            : 0.3;

    return {
      id: `ev_log_${i}`,
      source: 'logs' as const,
      kind: 'log' as const,
      title,
      timestamp: r.timestamp,
      relevance,
      payload: r,
      links: { traceId },
      provenance: { query, collectedAt },
    };
  });
}

export function errorBucketsToEvidence(
  buckets: ErrorBucket[],
  field: string,
  query: string,
  collectedAt: string,
): Evidence[] {
  return buckets.map((b, i) => ({
    id: `ev_logagg_${i}`,
    source: 'logs' as const,
    kind: 'log' as const,
    title: `${b.count}x ${field}=${b.key}`,
    relevance: Math.min(1, b.count / 100),
    payload: { field, ...b },
    links: {},
    provenance: { query, collectedAt },
  }));
}
