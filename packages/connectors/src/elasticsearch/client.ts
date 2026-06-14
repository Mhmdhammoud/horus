/**
 * Minimal Elasticsearch HTTP client for @horus/connectors (HOR-10).
 * Uses global fetch (Node 20+). No @elastic/elasticsearch dependency.
 */

import type { HealthStatus } from '@horus/core';

export interface ElasticsearchClientOpts {
  baseUrl: string;
  username?: string;
  password?: string;
}

export class ElasticsearchClient {
  private readonly baseUrl: string;
  private readonly authHeader: string | undefined;

  constructor(opts: ElasticsearchClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    if (opts.username !== undefined && opts.password !== undefined) {
      const encoded = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
      this.authHeader = `Basic ${encoded}`;
    }
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authHeader !== undefined) {
      headers['Authorization'] = this.authHeader;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Elasticsearch ${method} ${path} -> ${res.status}: ${text}`);
    }
    return res.json();
  }

  async search(index: string, body: unknown): Promise<unknown> {
    return this.request('POST', `/${index}/_search`, body);
  }

  async count(index: string, body: unknown): Promise<number> {
    const res = await this.request('POST', `/${index}/_count`, body);
    const typed = res as Record<string, unknown>;
    const count = typed['count'];
    return typeof count === 'number' ? count : 0;
  }

  async health(): Promise<HealthStatus> {
    try {
      const res = await this.request('GET', '/_cluster/health');
      const typed = res as Record<string, unknown>;
      const status = typed['status'];
      const detail = typeof status === 'string' ? status : 'ok';
      return { ok: true, detail };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
