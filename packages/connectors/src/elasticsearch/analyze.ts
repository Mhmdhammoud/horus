/**
 * Error-evidence synthesis for Elasticsearch logs (HOR-10).
 *
 * Horus does NOT dump logs — it converts them into Evidence. This module turns a
 * window of error-level logs into higher-level signals: distinct error signatures
 * with first/last occurrence and affected services, plus which signatures are NEW
 * or SPIKING relative to the preceding window. All builders/parsers are pure.
 */

import type { Evidence } from '@horus/core';
import {
  levelToValue,
  buildLevelFilter,
  buildTextMust,
  getField,
  serviceTermField,
  signatureTermField,
  MERITT_FIELD_MAPPING,
  type ElasticsearchFieldMapping,
  type LogQuery,
} from './normalize.js';

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
  /**
   * Structured context from a representative log of this signature (HOR-215).
   * Used to discover entity fields (brand_id, order_id, …) to aggregate on.
   */
  sampleContext?: Record<string, unknown>;
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
 * All field names are driven by `mapping` so the same config used for search
 * is also used for analysis (HOR-47).
 */
export function buildErrorAnalysisBody(
  q: LogQuery,
  field = 'event_code',
  mapping: ElasticsearchFieldMapping = MERITT_FIELD_MAPPING,
): Record<string, unknown> {
  const filters: unknown[] = [];

  const minLevel =
    q.level !== undefined && levelToValue(q.level) > 50 ? q.level : 'error';
  filters.push(buildLevelFilter(mapping, minLevel));

  if (q.from !== undefined || q.to !== undefined) {
    const rangeClause: Record<string, string> = {};
    if (q.from !== undefined) rangeClause['gte'] = q.from;
    if (q.to !== undefined) rangeClause['lte'] = q.to;
    filters.push({ range: { [mapping.timestampField]: rangeClause } });
  }

  if (q.service !== undefined) {
    filters.push({ term: { [serviceTermField(mapping)]: q.service } });
  }

  const mustClause = buildTextMust(q, mapping);

  const svcTerm = serviceTermField(mapping);
  const sigTerm =
    field === mapping.eventCodeField ? signatureTermField(mapping) : `${field}.keyword`;

  return {
    size: 0,
    track_total_hits: true,
    query: { bool: { filter: filters, must: mustClause } },
    aggs: {
      by_sig: {
        terms: { field: sigTerm, size: 25 },
        aggs: {
          first_seen: { min: { field: mapping.timestampField } },
          last_seen: { max: { field: mapping.timestampField } },
          services: { terms: { field: svcTerm, size: 10 } },
          sample: {
            top_hits: {
              size: 1,
              _source: [mapping.messageField, 'component', 'log_logger', 'context', 'detail'],
              sort: [{ [mapping.timestampField]: { order: 'desc' } }],
            },
          },
        },
      },
      affected_services: { terms: { field: svcTerm, size: 20 } },
    },
  };
}

function bucketsOf(node: unknown): Array<Record<string, unknown>> {
  const n = node as Record<string, unknown> | undefined;
  return (n?.['buckets'] ?? []) as Array<Record<string, unknown>>;
}

/**
 * Parse an error-analysis aggregation response into a LogAnalysis (no baseline).
 * `messageField` must match the field requested in the sample top_hits _source.
 */
export function parseErrorAnalysis(
  resp: unknown,
  window: { from?: string; to?: string },
  messageField = 'message',
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

    // Use the configured message field (supports dotted paths like 'log.message');
    // fall back to 'message' for backward compat.
    const rawMsg = getField(sampleSrc, messageField);
    const sampleMessage =
      typeof rawMsg === 'string'
        ? rawMsg
        : typeof sampleSrc['message'] === 'string'
          ? sampleSrc['message']
          : undefined;

    const ctx = sampleSrc['context'];
    const sampleContext =
      ctx !== null && typeof ctx === 'object' && !Array.isArray(ctx)
        ? (ctx as Record<string, unknown>)
        : undefined;

    return {
      key: String(b['key'] ?? '') || '(none)',
      count: typeof b['doc_count'] === 'number' ? b['doc_count'] : 0,
      firstSeen: typeof first === 'string' ? first : '',
      lastSeen: typeof last === 'string' ? last : '',
      services,
      sampleMessage,
      sampleComponent:
        typeof sampleSrc['component'] === 'string'
          ? sampleSrc['component']
          : typeof sampleSrc['log_logger'] === 'string'
            ? sampleSrc['log_logger']
            : undefined,
      ...(sampleContext !== undefined ? { sampleContext } : {}),
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

// ── Sensitive-field redaction (HOR-91) ───────────────────────────────────────

const REDACTION_PATTERNS: [RegExp, string][] = [
  // Authorization headers (Bearer / Basic / API-key tokens)
  [/(authorization\s*[=:]\s*)(bearer\s+)[^\s,"')]+/gi, '$1$2[REDACTED]'],
  [/(authorization\s*[=:]\s*)(basic\s+)[^\s,"')]+/gi, '$1$2[REDACTED]'],
  // Standalone password/token/secret keys in KV strings, query params, JSON
  [/("?(?:password|passwd|secret|token|api[_-]key|apikey|x-api-key)"?\s*[=:]\s*)"?[^"',\s)>]+/gi, '$1[REDACTED]'],
  // Cookie / set-cookie header values
  [/((?:cookie|set-cookie)\s*[=:]\s*)[^\s"',;>]{4,}/gi, '$1[REDACTED]'],
  // Database / service connection strings with embedded credentials
  [/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/)[^:@/\s]+:[^@\s]+@/gi, '$1[REDACTED]@'],
  // 16-digit card-number-like sequences (PCIDSS)
  [/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, '[REDACTED-CARD]'],
];

/**
 * Scrub common sensitive patterns (tokens, passwords, card numbers) from a
 * single string. Applied to sampleMessage before evidence reaches reports or
 * AI input. Purposely conservative — only known-bad patterns are removed.
 */
export function redactSensitiveString(s: string): string {
  let out = s;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Return a copy of an ErrorSignature with sampleMessage redacted.
 */
export function redactErrorSignature(sig: ErrorSignature): ErrorSignature {
  if (sig.sampleMessage === undefined) return sig;
  return { ...sig, sampleMessage: redactSensitiveString(sig.sampleMessage) };
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
      ...(s.isNew !== undefined ? { isNew: s.isNew } : {}),
      ...(typeof s.ratio === 'number' && Number.isFinite(s.ratio) ? { ratio: s.ratio } : {}),
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
