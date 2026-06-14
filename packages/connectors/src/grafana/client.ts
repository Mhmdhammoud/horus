/**
 * Grafana HTTP API client for @horus/connectors (HOR-11 reframe).
 * All Prometheus queries are routed through the Grafana datasource proxy —
 * no direct Prometheus access required.
 */

import type { HealthStatus } from '@horus/core';

export interface GrafanaClientOpts {
  baseUrl: string;
  username?: string;
  password?: string;
}

export class GrafanaClient {
  private readonly baseUrl: string;
  private readonly authHeader: string | undefined;

  constructor(opts: GrafanaClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    if (opts.username !== undefined && opts.password !== undefined) {
      const encoded = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
      this.authHeader = `Basic ${encoded}`;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authHeader !== undefined) {
      headers['Authorization'] = this.authHeader;
    }
    return headers;
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(url, { method: 'GET', headers: this.buildHeaders(), signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Grafana GET ${url} -> ${res.status}: ${text}`);
    }
    const json = await res.json().catch(() => {
      throw new Error(`Grafana GET ${url}: response is not valid JSON`);
    });
    return json;
  }

  /** GET /api/health — returns ok:true on 200. */
  async health(): Promise<HealthStatus> {
    try {
      await this.getJson(`${this.baseUrl}/api/health`);
      return { ok: true, detail: 'grafana ok' };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** GET /api/search?type=dash-db[&query=<q>] */
  async searchDashboards(
    query?: string,
    signal?: AbortSignal,
  ): Promise<{ uid: string; title: string; folderTitle?: string }[]> {
    const qs = new URLSearchParams({ type: 'dash-db' });
    if (query !== undefined && query !== '') {
      qs.set('query', query);
    }
    const url = `${this.baseUrl}/api/search?${qs.toString()}`;
    const raw = await this.getJson(url, signal);
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).map((item) => {
      const it = item as Record<string, unknown>;
      return {
        uid: String(it['uid'] ?? ''),
        title: String(it['title'] ?? ''),
        folderTitle:
          it['folderTitle'] !== undefined ? String(it['folderTitle']) : undefined,
      };
    });
  }

  /** GET /api/dashboards/uid/<uid> — returns the .dashboard object. */
  async getDashboard(uid: string, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.baseUrl}/api/dashboards/uid/${encodeURIComponent(uid)}`;
    const raw = await this.getJson(url, signal);
    const r = raw as Record<string, unknown>;
    return r['dashboard'];
  }

  /**
   * GET /api/datasources/proxy/uid/<dsUid>/api/v1/query_range
   * Returns the raw Prometheus response object.
   */
  async datasourceRange(
    dsUid: string,
    expr: string,
    startSecs: number,
    endSecs: number,
    stepSecs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const qs = new URLSearchParams({
      query: expr,
      start: String(startSecs),
      end: String(endSecs),
      step: String(stepSecs),
    });
    const url = `${this.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(dsUid)}/api/v1/query_range?${qs.toString()}`;
    const raw = await this.getJson(url, signal);
    const r = raw as Record<string, unknown>;
    if (r['status'] === 'error') {
      const errMsg = typeof r['error'] === 'string' ? r['error'] : 'unknown error';
      throw new Error(`Prometheus datasource error: ${errMsg}`);
    }
    return raw;
  }

  /**
   * GET /api/datasources/proxy/uid/<dsUid>/api/v1/query
   * Returns the raw Prometheus instant query response.
   */
  async datasourceInstant(
    dsUid: string,
    expr: string,
    timeSecs?: number,
  ): Promise<unknown> {
    const qs = new URLSearchParams({ query: expr });
    if (timeSecs !== undefined) {
      qs.set('time', String(timeSecs));
    }
    const url = `${this.baseUrl}/api/datasources/proxy/uid/${encodeURIComponent(dsUid)}/api/v1/query?${qs.toString()}`;
    const raw = await this.getJson(url);
    const r = raw as Record<string, unknown>;
    if (r['status'] === 'error') {
      const errMsg = typeof r['error'] === 'string' ? r['error'] : 'unknown error';
      throw new Error(`Prometheus datasource error: ${errMsg}`);
    }
    return raw;
  }
}
