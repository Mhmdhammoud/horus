import type {
  AxonCypherResult,
  AxonDiffResult,
  AxonHealth,
  AxonHostInfo,
  AxonImpactResult,
  AxonOverview,
  AxonSearchResult,
} from './types.js';

export class AxonHttpError extends Error {
  public status: number;
  public body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'AxonHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface AxonClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export class AxonHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: AxonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      let bodyStr: string | undefined;

      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        bodyStr = JSON.stringify(body);
      }

      const res = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new AxonHttpError(
          `Axon request failed: ${method} ${path} -> HTTP ${res.status}`,
          res.status,
          text,
        );
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<AxonHealth> {
    const url = `${this.baseUrl}/api/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  hostInfo(): Promise<AxonHostInfo> {
    return this.request<AxonHostInfo>('GET', '/api/host');
  }

  overview(): Promise<AxonOverview> {
    return this.request<AxonOverview>('GET', '/api/overview');
  }

  cypher(query: string): Promise<AxonCypherResult> {
    return this.request<AxonCypherResult>('POST', '/api/cypher', { query });
  }

  async search(query: string, limit = 20): Promise<AxonSearchResult[]> {
    const res = await this.request<{ results: AxonSearchResult[] }>('POST', '/api/search', {
      query,
      limit,
    });
    return res.results;
  }

  impact(nodeId: string, depth = 3): Promise<AxonImpactResult> {
    return this.request<AxonImpactResult>(
      'GET',
      `/api/impact/${encodeURI(nodeId)}?depth=${depth}`,
    );
  }

  diff(base: string, compare: string): Promise<AxonDiffResult> {
    return this.request<AxonDiffResult>('POST', '/api/diff', { base, compare });
  }

  async nodeCount(): Promise<number> {
    const result = await this.cypher('MATCH (n) RETURN count(n)');
    return Number(result.rows[0]?.[0]) || 0;
  }
}
