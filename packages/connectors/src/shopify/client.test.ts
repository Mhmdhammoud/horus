import { describe, it, expect, vi, afterEach } from 'vitest';
import { ShopifyAdminClient, normalizeStore, normalizeApiVersion, isThrottled } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeStore', () => {
  it('appends .myshopify.com to a bare subdomain', () => {
    expect(normalizeStore('my-store')).toBe('my-store.myshopify.com');
    // Users enter just the subdomain (e.g. Maison's "946011-c0"); Horus adds the rest.
    expect(normalizeStore('946011-c0')).toBe('946011-c0.myshopify.com');
  });
  it('strips scheme and trailing slash', () => {
    expect(normalizeStore('https://my-store.myshopify.com/')).toBe('my-store.myshopify.com');
  });
  it('leaves a full domain untouched', () => {
    expect(normalizeStore('my-store.myshopify.com')).toBe('my-store.myshopify.com');
  });
});

describe('normalizeApiVersion', () => {
  it('accepts a valid YYYY-MM version', () => {
    expect(normalizeApiVersion('2025-01')).toBe('2025-01');
  });
  it('defaults on garbage / empty / undefined', () => {
    expect(normalizeApiVersion('nope')).toBe('2025-10');
    expect(normalizeApiVersion('')).toBe('2025-10');
    expect(normalizeApiVersion(undefined)).toBe('2025-10');
  });
});

describe('isThrottled', () => {
  it('detects a THROTTLED GraphQL error', () => {
    expect(isThrottled({ errors: [{ message: 'x', extensions: { code: 'THROTTLED' } }] })).toBe(true);
  });
  it('is false for a normal response', () => {
    expect(isThrottled({ data: {} })).toBe(false);
  });
});

describe('ShopifyAdminClient.graphql — Client-Credentials grant', () => {
  it('exchanges client_id/secret for a token, then runs the query verbatim with X-Shopify-Access-Token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.endsWith('/admin/oauth/access_token')) {
          return new Response(JSON.stringify({ access_token: 'shpat_xyz', expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ data: { shop: { name: 'Acme' } }, extensions: { cost: {} } }),
          { status: 200 },
        );
      }),
    );

    const client = new ShopifyAdminClient({
      store: 'acme',
      apiVersion: '2025-10',
      accessId: 'client-id',
      secret: 'client-secret',
    });
    const result = await client.graphql('query { shop { name } }', { a: 1 });

    const tokenCall = calls.find((c) => c.url.endsWith('/admin/oauth/access_token'))!;
    expect(tokenCall.url).toBe('https://acme.myshopify.com/admin/oauth/access_token');
    expect((tokenCall.init!.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    // Form-encoded body (URLSearchParams), matching Shopify's OAuth endpoint.
    const tokenParams = new URLSearchParams(String(tokenCall.init!.body));
    expect(Object.fromEntries(tokenParams)).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'client_credentials',
    });

    const gqlCall = calls.find((c) => c.url.includes('/graphql.json'))!;
    expect(gqlCall.url).toBe('https://acme.myshopify.com/admin/api/2025-10/graphql.json');
    expect((gqlCall.init!.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_xyz');
    expect(JSON.parse(String(gqlCall.init!.body))).toEqual({
      query: 'query { shop { name } }',
      variables: { a: 1 },
    });
    expect(result.data).toEqual({ shop: { name: 'Acme' } });
  });

  it('caches the token across calls (one exchange for two queries)', async () => {
    let exchanges = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL): Promise<Response> => {
        if (String(url).endsWith('/admin/oauth/access_token')) {
          exchanges += 1;
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }),
    );
    const client = new ShopifyAdminClient({ store: 'acme', accessId: 'id', secret: 'sec' });
    await client.graphql('q1');
    await client.graphql('q2');
    expect(exchanges).toBe(1);
  });

  it('uses the secret directly as the token when no accessId (no grant)', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new ShopifyAdminClient({ store: 'acme', secret: 'shpat_direct' });
    await client.graphql('q');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain('/oauth/access_token');
    expect((init!.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_direct');
  });

  it('throws with a truncated message on a non-2xx GraphQL response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const client = new ShopifyAdminClient({ store: 'acme', secret: 'tok' });
    await expect(client.graphql('q')).rejects.toThrow(/Shopify GraphQL -> 500/);
  });

  it('retries once on HTTP 429 then succeeds', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        n += 1;
        if (n === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }),
    );
    const client = new ShopifyAdminClient({ store: 'acme', secret: 'tok' });
    const result = await client.graphql('q');
    expect(result.data).toEqual({ ok: true });
    expect(n).toBe(2);
  });
});

describe('ShopifyAdminClient.health', () => {
  it('CC mode: ok when grant + shop probe succeed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL): Promise<Response> => {
        if (String(url).endsWith('/admin/oauth/access_token')) {
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { shop: { name: 'Acme' } } }), { status: 200 });
      }),
    );
    const client = new ShopifyAdminClient({ store: 'acme', accessId: 'id', secret: 'sec' });
    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('acme.myshopify.com');
  });

  it('CC mode: not-ok (never throws) when the grant fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const client = new ShopifyAdminClient({ store: 'acme', accessId: 'id', secret: 'bad' });
    const h = await client.health();
    expect(h.ok).toBe(false);
  });

  it('static-token mode: ok when the shop probe succeeds (no grant)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL): Promise<Response> => {
        expect(String(url)).not.toContain('/oauth/access_token');
        return new Response(JSON.stringify({ data: { shop: { name: 'Acme' } } }), { status: 200 });
      }),
    );
    const client = new ShopifyAdminClient({ store: 'acme', secret: 'shpat_ok' });
    const h = await client.health();
    expect(h.ok).toBe(true);
  });

  it('static-token mode: not-ok when the token is rejected (401)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"errors":"[API] Invalid API key or access token"}', { status: 401 })));
    const client = new ShopifyAdminClient({ store: 'acme', secret: 'shpat_bad' });
    const h = await client.health();
    expect(h.ok).toBe(false);
  });
});
