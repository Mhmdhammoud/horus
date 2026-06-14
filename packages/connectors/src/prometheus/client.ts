/**
 * Minimal Prometheus HTTP API client for @horus/connectors (HOR-11).
 * Uses global fetch (Node 20+). Supports direct Prometheus or Grafana datasource proxy.
 */

import type { HealthStatus } from '@horus/core';

export interface PrometheusClientOpts {
  /** Prometheus API base URL. For Grafana proxy: ${GRAFANA_URL}/api/datasources/proxy/uid/Prometheus */
  baseUrl: string;
  username?: string;
  password?: string;
}

export class PrometheusClient {
  private readonly baseUrl: string;
  private readonly authHeader: string | undefined;

  constructor(opts: PrometheusClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    if (opts.username !== undefined && opts.password !== undefined) {
      const encoded = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
      this.authHeader = `Basic ${encoded}`;
    }
  }

  async request(path: string, params: Record<string, string | number>): Promise<unknown> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      qs.set(k, String(v));
    }
    const qsPart = qs.toString();
    const url = `${this.baseUrl}${path}${qsPart ? `?${qsPart}` : ''}`;

    const headers: Record<string, string> = {};
    if (this.authHeader !== undefined) {
      headers['Authorization'] = this.authHeader;
    }

    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Prometheus GET ${path} -> ${res.status}: ${text}`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    if (json['status'] === 'error') {
      const errMsg = typeof json['error'] === 'string' ? json['error'] : 'unknown error';
      throw new Error(`Prometheus error: ${errMsg}`);
    }

    return json;
  }

  /** Instant vector query: GET /api/v1/query */
  async instantQuery(query: string, timeSecs?: number): Promise<unknown> {
    const params: Record<string, string | number> = { query };
    if (timeSecs !== undefined) {
      params['time'] = timeSecs;
    }
    return this.request('/api/v1/query', params);
  }

  /** Range query: GET /api/v1/query_range */
  async rangeQuery(
    query: string,
    startSecs: number,
    endSecs: number,
    stepSecs: number,
  ): Promise<unknown> {
    return this.request('/api/v1/query_range', {
      query,
      start: startSecs,
      end: endSecs,
      step: stepSecs,
    });
  }

  /** List label values: GET /api/v1/label/{label}/values -> string[] */
  async labelValues(label: string): Promise<string[]> {
    const resp = await this.request(`/api/v1/label/${encodeURIComponent(label)}/values`, {});
    const r = resp as Record<string, unknown>;
    const data = r['data'];
    if (!Array.isArray(data)) return [];
    return data.filter((v): v is string => typeof v === 'string');
  }

  /** Health check via vector(1) instant query. */
  async health(): Promise<HealthStatus> {
    try {
      await this.instantQuery('vector(1)');
      return { ok: true, detail: 'prometheus ok' };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
