/**
 * Read-only Axiom logs client for @horus/connectors (HOR-429).
 *
 * Axiom is a structured-log source queried with APL (Axiom Processing Language).
 * Each row is a log event whose fields Horus folds into `kind: 'log'` Evidence — a
 * direct seed for the investigation engine alongside Elasticsearch / Sentry.
 *
 * Safety: only read endpoints are used (dataset listing + APL queries; the `_apl`
 * endpoint is read-only). Auth is `Authorization: Bearer <token>`. Every request is
 * bounded by an 8s AbortSignal.timeout. The client never throws past its callers —
 * `listDatasets`/`query` return [] on any failure and `health()` returns a structured
 * `{ ok, detail }`. No `@axiomhq/*` SDK — `fetch` only.
 */

import type { HealthStatus } from '@horus/core';

export interface AxiomClientOpts {
  /** API token (sent as `Authorization: Bearer <token>`). */
  token: string;
  /** Dataset to query (an Axiom dataset is the rough analogue of an ES index). */
  dataset: string;
  /**
   * Base URL. Defaults to the US region (https://api.axiom.co). Use
   * https://api.eu.axiom.co for the EU region. Trailing slash is trimmed.
   */
  baseUrl?: string;
}

/** A dataset descriptor, trimmed to what Horus needs. */
export interface AxiomDataset {
  name: string;
  description?: string;
}

/** One log event row from an APL query — its fields plus a hoisted `_time`. */
export interface AxiomLogRecord {
  /** ISO timestamp of the event (Axiom's `_time` field) when present. */
  timestamp?: string;
  /** All row fields as a flat record (column name -> value). */
  fields: Record<string, unknown>;
}

const REQUEST_TIMEOUT_MS = 8000;
const APL_PATH = '/v1/datasets/_apl?format=tabular';

export class AxiomClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly dataset: string;

  constructor(opts: AxiomClientOpts) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.axiom.co').replace(/\/$/, '');
    this.token = opts.token;
    this.dataset = opts.dataset;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Axiom ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  /**
   * List the datasets reachable with the configured token. Returns [] on any error so
   * callers degrade gracefully (never throws past here).
   */
  async listDatasets(): Promise<AxiomDataset[]> {
    try {
      const raw = await this.request('GET', '/v1/datasets');
      if (!Array.isArray(raw)) return [];
      return (raw as Array<Record<string, unknown>>).map(parseDataset);
    } catch {
      return [];
    }
  }

  /**
   * Run an APL query over the configured time window. `startTime`/`endTime` are ISO
   * strings and bound the query server-side. Returns parsed log records, or [] on any
   * failure (never throws past here).
   */
  async query(apl: string, startTime: string, endTime: string): Promise<AxiomLogRecord[]> {
    try {
      const raw = await this.request('POST', APL_PATH, { apl, startTime, endTime });
      return parseTabular(raw);
    } catch {
      return [];
    }
  }

  /**
   * Cheap reachability probe: list datasets. Returns a structured status; never throws.
   */
  async health(): Promise<HealthStatus> {
    try {
      await this.request('GET', '/v1/datasets');
      return { ok: true, detail: `axiom reachable (${this.dataset})` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

/** Coerce a dataset JSON entry into an AxiomDataset. */
export function parseDataset(raw: Record<string, unknown>): AxiomDataset {
  const ds: AxiomDataset = { name: String(raw['name'] ?? '') };
  if (typeof raw['description'] === 'string' && raw['description'] !== '') {
    ds.description = raw['description'];
  }
  return ds;
}

/**
 * Build an APL query string over a dataset. When `hintTerms` are supplied, a
 * full-text `search` clause OR-joins the domain-relevant terms (length > 2) so the
 * window is biased toward rows mentioning the investigation hint. Results are sorted
 * newest-first and capped. Pure + exported for unit testing.
 */
export function buildApl(dataset: string, hintTerms: string[] = [], limit = 100): string {
  const ds = `['${dataset.replace(/'/g, '')}']`;
  const terms = hintTerms.map((t) => t.trim()).filter((t) => t.length > 2);
  const search =
    terms.length > 0
      ? ` | search ${terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' or ')}`
      : '';
  const lim = Math.max(1, Math.min(limit, 1000));
  return `${ds}${search} | sort by _time desc | limit ${lim}`;
}

/**
 * Parse Axiom's tabular APL response into flat log records. Axiom returns a
 * `tables[]` array; each table carries `fields` (column metadata: `{ name, type }`)
 * plus the data either column-oriented (`columns: [[...col0], [...col1]]`) or
 * row-oriented (`rows: [[...row0], [...row1]]`). Both shapes are supported. `_time`
 * is hoisted to `timestamp`. Pure + exported for unit testing against captured JSON.
 */
export function parseTabular(raw: unknown): AxiomLogRecord[] {
  if (raw === null || raw === undefined || typeof raw !== 'object') return [];
  const tables = (raw as Record<string, unknown>)['tables'];
  if (!Array.isArray(tables)) return [];

  const records: AxiomLogRecord[] = [];
  for (const table of tables as Array<Record<string, unknown>>) {
    const fields = table['fields'];
    if (!Array.isArray(fields)) continue;
    const names = (fields as Array<Record<string, unknown>>).map((f) => String(f['name'] ?? ''));

    const columns = table['columns'];
    const rows = table['rows'];

    if (Array.isArray(columns)) {
      // Column-oriented: columns[c][r] is the value of field c in row r.
      const first = columns[0];
      const rowCount = Array.isArray(first) ? first.length : 0;
      for (let r = 0; r < rowCount; r++) {
        const row: Record<string, unknown> = {};
        for (let c = 0; c < names.length; c++) {
          const col = columns[c];
          if (Array.isArray(col)) row[names[c]!] = col[r];
        }
        records.push(toRecord(row));
      }
    } else if (Array.isArray(rows)) {
      // Row-oriented: rows[r][c] is the value of field c in row r.
      for (const rowVals of rows as unknown[][]) {
        if (!Array.isArray(rowVals)) continue;
        const row: Record<string, unknown> = {};
        for (let c = 0; c < names.length; c++) {
          row[names[c]!] = rowVals[c];
        }
        records.push(toRecord(row));
      }
    }
  }
  return records;
}

function toRecord(fields: Record<string, unknown>): AxiomLogRecord {
  const rec: AxiomLogRecord = { fields };
  const t = fields['_time'];
  if (typeof t === 'string') rec.timestamp = t;
  return rec;
}
