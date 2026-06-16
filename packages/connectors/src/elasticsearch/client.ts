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

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
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
    if (signal !== undefined) {
      init.signal = signal;
    }

    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Elasticsearch ${method} ${path} -> ${res.status}: ${text}`);
    }
    return res.json();
  }

  async search(index: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('POST', `/${index}/_search`, body, signal);
  }

  async fieldCaps(index: string, fields: string[], signal?: AbortSignal): Promise<unknown> {
    const encoded = fields.map(encodeURIComponent).join(',');
    // allow_no_indices + ignore_unavailable: return empty response instead of 404
    // when the index pattern matches nothing — lets validateMappingAgainstCaps
    // produce the actionable "no indices" diagnostic rather than throwing.
    return this.request(
      'GET',
      `/${index}/_field_caps?fields=${encoded}&allow_no_indices=true&ignore_unavailable=true`,
      undefined,
      signal,
    );
  }

  async count(index: string, body: unknown, signal?: AbortSignal): Promise<number> {
    const res = await this.request('POST', `/${index}/_count`, body, signal);
    const typed = res as Record<string, unknown>;
    const count = typed['count'];
    return typeof count === 'number' ? count : 0;
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    try {
      const res = await this.request('GET', '/_cluster/health', undefined, signal);
      const typed = res as Record<string, unknown>;
      const status = typed['status'];
      const detail = typeof status === 'string' ? status : 'ok';
      return { ok: true, detail };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /**
   * Discover available index names. Resolution order:
   *   1. Data streams (modern ILM — clean names without date suffixes)
   *   2. Aliases (user-defined names mapping to one or more indices)
   *   3. Raw concrete indices (fallback for legacy clusters)
   * System entries (starting with '.') are always filtered out.
   * Returns [] on any error so callers can gracefully fall back.
   */
  async listIndices(signal?: AbortSignal): Promise<string[]> {
    const results = new Set<string>();

    // 1. Data streams
    try {
      const dsRes = await this.request('GET', '/_data_stream', undefined, signal) as Record<string, unknown>;
      const streams = dsRes['data_streams'] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(streams)) {
        for (const s of streams) {
          const name = String(s['name'] ?? '');
          if (name && !name.startsWith('.')) results.add(name);
        }
      }
    } catch {
      // data stream API not available or no streams — continue
    }

    // 2. Aliases
    try {
      const aliasRes = await this.request(
        'GET',
        '/_cat/aliases?format=json&h=alias&s=alias',
        undefined,
        signal,
      );
      if (Array.isArray(aliasRes)) {
        for (const a of aliasRes as Array<Record<string, unknown>>) {
          const alias = String(a['alias'] ?? '');
          if (alias && !alias.startsWith('.')) results.add(alias);
        }
      }
    } catch {
      // aliases not available — continue
    }

    // 3. Raw indices (only when neither data streams nor aliases were found)
    if (results.size === 0) {
      try {
        const idxRes = await this.request(
          'GET',
          '/_cat/indices?format=json&h=index&s=index&expand_wildcards=open',
          undefined,
          signal,
        );
        if (Array.isArray(idxRes)) {
          for (const r of idxRes as Array<Record<string, unknown>>) {
            const name = String(r['index'] ?? '');
            if (name && !name.startsWith('.')) results.add(name);
          }
        }
      } catch {
        // nothing available
      }
    }

    return [...results].sort();
  }
}
