/**
 * Error-evidence synthesis for Elasticsearch logs (HOR-10).
 *
 * Horus does NOT dump logs — it converts them into Evidence. This module turns a
 * window of error-level logs into higher-level signals: distinct error signatures
 * with first/last occurrence and affected services, plus which signatures are NEW
 * or SPIKING relative to the preceding window. All builders/parsers are pure.
 */

import type { Evidence } from '@horus/core';
import { levelToValue, type LogQuery } from './normalize.js';

export interface ErrorSignature {
  /** The error key (event_code), or '(none)' when absent. */
  key: string;
  count: number;
  /** ISO timestamp of the earliest occurrence in the window. */
  firstSeen: string;
  /** ISO timestamp of the latest occurrence in the window. */
  lastSeen: string;
  /** Services that emitted this signature. */
  services: string[];
  sampleMessage?: string;
  sampleComponent?: string;
  /** True when this signature did not occur in the baseline (preceding) window. */
  isNew?: boolean;
  baselineCount?: number;
  /** current/baseline volume ratio (Infinity when new). */
  ratio?: number;
}

export interface LogAnalysis {
  window: { from?: string; to?: string };
  totalErrors: number;
  signatures: ErrorSignature[];
  /** Keys of signatures absent from the baseline window. */
  newSignatures: string[];
  affectedServices: string[];
}

/** Short, human "MM-DD HH:MM" form of an ISO timestamp (empty-safe). */
export function shortTs(iso: string): string {
  if (!iso || iso.length < 16) return iso || '—';
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Build the error-analysis aggregation body: per-signature count, first/last
 * occurrence, affected services, and a representative sample message; plus the
 * overall affected-services breakdown. `field` keys the signature (event_code).
 */
export function buildErrorAnalysisBody(
  q: LogQuery,
  field = 'event_code',
): Record<string, unknown> {
  const filters: unknown[] = [];

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

  const mustClause: unknown[] =
    q.text !== undefined ? [{ match: { message: q.text } }] : [{ match_all: {} }];

  return {
    size: 0,
    track_total_hits: true,
    query: { bool: { filter: filters, must: mustClause } },
    aggs: {
      by_sig: {
        terms: { field: `${field}.keyword`, size: 25 },
        aggs: {
          first_seen: { min: { field: 'time' } },
          last_seen: { max: { field: 'time' } },
          services: { terms: { field: 'service_name.keyword', size: 10 } },
          sample: {
            top_hits: {
              size: 1,
              _source: ['message', 'component', 'log_logger'],
              sort: [{ time: { order: 'desc' } }],
            },
          },
        },
      },
      affected_services: { terms: { field: 'service_name.keyword', size: 20 } },
    },
  };
}

function bucketsOf(node: unknown): Array<Record<string, unknown>> {
  const n = node as Record<string, unknown> | undefined;
  return (n?.['buckets'] ?? []) as Array<Record<string, unknown>>;
}

/** Parse an error-analysis aggregation response into a LogAnalysis (no baseline). */
export function parseErrorAnalysis(
  resp: unknown,
  window: { from?: string; to?: string },
): LogAnalysis {
  const res = resp as Record<string, unknown>;
  const aggs = (res['aggregations'] ?? {}) as Record<string, unknown>;

  const hits = res['hits'] as Record<string, unknown> | undefined;
  const totalNode = hits?.['total'];
  const totalErrors =
    typeof totalNode === 'number'
      ? totalNode
      : typeof (totalNode as Record<string, unknown> | undefined)?.['value'] === 'number'
        ? ((totalNode as Record<string, unknown>)['value'] as number)
        : 0;

  const signatures: ErrorSignature[] = bucketsOf(aggs['by_sig']).map((b) => {
    const first = (b['first_seen'] as Record<string, unknown> | undefined)?.[
      'value_as_string'
    ];
    const last = (b['last_seen'] as Record<string, unknown> | undefined)?.[
      'value_as_string'
    ];
    const services = bucketsOf(b['services']).map((s) => String(s['key'] ?? ''));
    const sampleHits = ((b['sample'] as Record<string, unknown> | undefined)?.['hits'] ??
      {}) as Record<string, unknown>;
    const sampleArr = (sampleHits['hits'] ?? []) as Array<Record<string, unknown>>;
    const sampleSrc = (sampleArr[0]?.['_source'] ?? {}) as Record<string, unknown>;

    return {
      key: String(b['key'] ?? '') || '(none)',
      count: typeof b['doc_count'] === 'number' ? b['doc_count'] : 0,
      firstSeen: typeof first === 'string' ? first : '',
      lastSeen: typeof last === 'string' ? last : '',
      services,
      sampleMessage:
        typeof sampleSrc['message'] === 'string' ? sampleSrc['message'] : undefined,
      sampleComponent:
        typeof sampleSrc['component'] === 'string'
          ? sampleSrc['component']
          : typeof sampleSrc['log_logger'] === 'string'
            ? sampleSrc['log_logger']
            : undefined,
    };
  });

  const affectedServices = bucketsOf(aggs['affected_services']).map((s) =>
    String(s['key'] ?? ''),
  );

  return { window, totalErrors, signatures, newSignatures: [], affectedServices };
}

/**
 * Annotate a current analysis against a baseline window's signatures: mark NEW
 * signatures and compute spike ratios. Mutates and returns `current`.
 */
export function annotateAgainstBaseline(
  current: LogAnalysis,
  baseline: ErrorSignature[],
): LogAnalysis {
  const baseMap = new Map<string, number>(baseline.map((s) => [s.key, s.count]));
  const newSignatures: string[] = [];

  for (const s of current.signatures) {
    const b = baseMap.get(s.key) ?? 0;
    s.baselineCount = b;
    s.isNew = b === 0;
    s.ratio = b === 0 ? (s.count > 0 ? Infinity : 0) : s.count / b;
    if (s.isNew) newSignatures.push(s.key);
  }

  current.newSignatures = newSignatures;
  return current;
}

/**
 * Convert a LogAnalysis into Evidence records (one per signature + an
 * affected-services summary). Synthesized signals, never raw log dumps.
 */
export function analysisToEvidence(
  analysis: LogAnalysis,
  query: string,
  collectedAt: string,
): Evidence[] {
  const out: Evidence[] = [];

  analysis.signatures.forEach((s, i) => {
    const tags: string[] = [];
    if (s.isNew) tags.push('NEW');
    else if (s.ratio !== undefined && Number.isFinite(s.ratio) && s.ratio >= 1.5) {
      tags.push(`spike x${s.ratio.toFixed(1)}`);
    }
    const svc = s.services.length > 0 ? ` · ${s.services.slice(0, 3).join(', ')}` : '';
    const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    const title =
      `Error ${s.key}: ${s.count}x (first ${shortTs(s.firstSeen)}, last ${shortTs(s.lastSeen)})${svc}${tagStr}`.slice(
        0,
        180,
      );
    const relevance = s.isNew
      ? 0.95
      : s.ratio !== undefined && s.ratio >= 1.5
        ? 0.9
        : 0.8;

    out.push({
      id: `ev_errsig_${i}`,
      source: 'logs',
      kind: 'log',
      title,
      relevance,
      payload: s,
      links: {},
      provenance: { query, collectedAt },
      ...(s.lastSeen ? { timestamp: s.lastSeen } : {}),
    });
  });

  if (analysis.affectedServices.length > 0) {
    out.push({
      id: 'ev_affected_services',
      source: 'logs',
      kind: 'log',
      title: `Affected service(s): ${analysis.affectedServices.join(', ')} (${analysis.totalErrors} error(s))`,
      relevance: 0.6,
      payload: { services: analysis.affectedServices, totalErrors: analysis.totalErrors },
      links: {},
      provenance: { query, collectedAt },
    });
  }

  return out;
}
