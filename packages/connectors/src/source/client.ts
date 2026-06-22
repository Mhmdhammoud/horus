import type {
  SourceCypherResult,
  SourceDiffResult,
  SourceHealth,
  SourceHostInfo,
  SourceImpactResult,
  SourceOverview,
  SourceSearchResult,
} from './types.js';

export class SourceHttpError extends Error {
  public status: number;
  public body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'SourceHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface SourceClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class SourceHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: SourceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {};
    let bodyStr: string | undefined;

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(url, {
          method,
          headers,
          body: bodyStr,
          signal: controller.signal,
        });

        if (res.status >= 500) {
          const text = await res.text();
          if (attempt < this.maxRetries) {
            await this.sleep(150 * 2 ** attempt);
            continue;
          }
          throw new SourceHttpError(
            `Source request failed: ${method} ${path} -> HTTP ${res.status}`,
            res.status,
            text,
          );
        }

        if (!res.ok) {
          // 4xx — never retry
          const text = await res.text();
          throw new SourceHttpError(
            `Source request failed: ${method} ${path} -> HTTP ${res.status}`,
            res.status,
            text,
          );
        }

        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof SourceHttpError) {
          throw err;
        }
        // Distinguish AbortError (timeout/cancel) from network errors
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
        // Network error — retry if attempts remain
        if (attempt < this.maxRetries) {
          await this.sleep(150 * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    // Unreachable — TypeScript needs a return here
    throw new Error('Unexpected end of retry loop');
  }

  async version(): Promise<string | null> {
    const url = `${this.baseUrl}/openapi.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const data = (await res.json()) as { info?: { version?: string } };
      return data.info?.version ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<SourceHealth> {
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

  hostInfo(): Promise<SourceHostInfo> {
    return this.request<SourceHostInfo>('GET', '/api/host');
  }

  overview(): Promise<SourceOverview> {
    return this.request<SourceOverview>('GET', '/api/overview');
  }

  cypher(query: string): Promise<SourceCypherResult> {
    return this.request<SourceCypherResult>('POST', '/api/cypher', { query });
  }

  async search(query: string, limit = 20): Promise<SourceSearchResult[]> {
    const res = await this.request<{ results: SourceSearchResult[] }>('POST', '/api/search', {
      query,
      limit,
    });
    return res.results;
  }

  impact(nodeId: string, depth = 3): Promise<SourceImpactResult> {
    return this.request<SourceImpactResult>(
      'GET',
      `/api/impact/${encodeURI(nodeId)}?depth=${depth}`,
    );
  }

  diff(base: string, compare: string): Promise<SourceDiffResult> {
    return this.request<SourceDiffResult>('POST', '/api/diff', { base, compare });
  }

  async nodeCount(): Promise<number> {
    const result = await this.cypher('MATCH (n) RETURN count(n)');
    return Number(result.rows[0]?.[0]) || 0;
  }
}
