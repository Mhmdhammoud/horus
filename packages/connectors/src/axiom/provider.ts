/**
 * Axiom logs-evidence provider (HOR-429).
 *
 * Axiom is a structured-log source: each APL row is a log event. This provider mirrors
 * the Elasticsearch / Sentry logs providers — it synthesizes one `kind: 'log'` Evidence
 * per row so it folds straight into the engine's existing log/error-evidence machinery.
 * The row's fields are surfaced on the payload; message + level + timestamp drive the
 * human title and relevance.
 *
 * Privacy: the message rendered into the title is redacted. priority / category /
 * subject are NOT set here — the normalization layer stamps those.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import { redactSecrets } from '@horus/core';
import type { Provider } from '../contract.js';
import { AxiomClient, buildApl, type AxiomLogRecord } from './client.js';

export interface AxiomProviderOpts {
  /** Dataset to query (also used for evidence provenance + APL building). */
  dataset: string;
  /** How many recent rows to fold in (capped 1–1000). */
  limit?: number;
  /** Default lookback window in milliseconds when no explicit from/to is given. */
  windowMs?: number;
}

/** Default lookback: 24h. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export class AxiomProvider implements Provider {
  readonly id = 'axiom';
  readonly kind: ProviderKind = 'logs';

  constructor(
    private readonly client: AxiomClient,
    private readonly opts: AxiomProviderOpts,
  ) {}

  /**
   * Collect recent log rows over the window. Builds a sensible APL query (newest-first,
   * optionally biased toward `hintTerms`) and runs it. Best-effort: a failing query
   * yields []. Never throws.
   */
  async collect(
    opts: { from?: string; to?: string; hintTerms?: string[] } = {},
  ): Promise<AxiomLogRecord[]> {
    const to = opts.to ?? new Date().toISOString();
    const from =
      opts.from ??
      new Date(Date.parse(to) - (this.opts.windowMs ?? DEFAULT_WINDOW_MS)).toISOString();
    const apl = buildApl(this.opts.dataset, opts.hintTerms ?? [], this.opts.limit ?? 100);
    return this.client.query(apl, from, to);
  }

  /**
   * Synthesize Evidence from Axiom rows. One `kind: 'log'` Evidence per row, with the
   * row fields on the payload (under `source: 'axiom'`), a redacted message in the
   * title, and relevance weighted by hint-term match / recency / level.
   */
  toEvidence(records: AxiomLogRecord[], hintTerms: string[], collectedAt: string): Evidence[] {
    const query = `axiom ${this.opts.dataset}`;
    return records.map((rec, i) =>
      this.recordToEvidence(rec, hintTerms, query, collectedAt, i),
    );
  }

  /**
   * One-shot evidence query: collect rows + convert to Evidence. Preferred entry point
   * for the investigation engine. Degrades to [] on any failure so a flaky Axiom never
   * aborts an investigation.
   */
  async queryEvidence(
    opts: { from?: string; to?: string; hintTerms?: string[]; collectedAt?: string } = {},
  ): Promise<Evidence[]> {
    try {
      const hintTerms = opts.hintTerms ?? [];
      const records = await this.collect({
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        hintTerms,
      });
      return this.toEvidence(records, hintTerms, opts.collectedAt ?? new Date().toISOString());
    } catch {
      return [];
    }
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }

  private recordToEvidence(
    rec: AxiomLogRecord,
    hintTerms: string[],
    query: string,
    collectedAt: string,
    index: number,
  ): Evidence {
    const title = buildTitle(rec, this.opts.dataset);
    const relevance = computeRelevance(rec, hintTerms);

    const payload: Record<string, unknown> = {
      source: 'axiom',
      dataset: this.opts.dataset,
      ...rec.fields,
    };

    const ev: Evidence = {
      id: `ev_axiom_${index}`,
      source: 'logs',
      kind: 'log',
      title,
      relevance,
      payload,
      links: {},
      provenance: { query, collectedAt },
    };
    if (rec.timestamp !== undefined) ev.timestamp = rec.timestamp;
    return ev;
  }
}

/** Common field names that hold the log message body, in priority order. */
const MESSAGE_FIELDS = ['message', 'msg', 'body', 'event', 'log', '_raw'];
/** Common field names that hold the log level/severity, in priority order. */
const LEVEL_FIELDS = ['level', 'severity', 'lvl', 'loglevel', 'status'];

/** Pick the first present, non-empty string-ish value among `candidates`. */
function pickField(fields: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const key of candidates) {
    const v = fields[key];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/**
 * Build the human one-line title: dataset, level, redacted message, and short
 * timestamp. Pure + exported for unit testing.
 */
export function buildTitle(rec: AxiomLogRecord, dataset: string): string {
  const msg = pickField(rec.fields, MESSAGE_FIELDS);
  const level = pickField(rec.fields, LEVEL_FIELDS);
  const lvl = level ? `[${level}] ` : '';
  const body = msg ? redactSecrets(msg) : '(log event)';
  const ts = rec.timestamp ? ` · ${shortTs(rec.timestamp)}` : '';
  return `Axiom ${dataset}: ${lvl}${body}${ts}`.slice(0, 220);
}

/**
 * Relevance-weight a row by hint-term match (over all fields), recency, and log level.
 * Range ~0.5–0.95. Pure + exported for unit testing.
 */
export function computeRelevance(
  rec: AxiomLogRecord,
  hintTerms: string[],
  now: number = Date.now(),
): number {
  let score = 0.6;

  const hay = JSON.stringify(rec.fields).toLowerCase();
  const domainTerms = hintTerms.filter((t) => t.length > 2);
  if (domainTerms.some((t) => hay.includes(t.toLowerCase()))) score += 0.2;

  // Recency: rows seen in the last 24h are the most actionable.
  if (rec.timestamp) {
    const ageMs = now - Date.parse(rec.timestamp);
    if (Number.isFinite(ageMs)) {
      if (ageMs <= 86_400_000) score += 0.1;
      else if (ageMs <= 7 * 86_400_000) score += 0.05;
    }
  }

  // Level: errors are more likely the active incident than info/debug noise.
  const level = (pickField(rec.fields, LEVEL_FIELDS) ?? '').toLowerCase();
  if (level === 'error' || level === 'fatal' || level === 'critical') score += 0.1;
  else if (level === 'warn' || level === 'warning') score += 0.05;

  return Math.min(0.95, Math.max(0.5, score));
}

/** Short, human "MM-DD HH:MM" form of an ISO timestamp (empty-safe). */
function shortTs(iso: string): string {
  if (!iso || iso.length < 16) return iso || '—';
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}
