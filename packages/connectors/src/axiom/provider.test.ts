import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AxiomClient,
  AxiomProvider,
  buildTitle,
  computeRelevance,
  type AxiomLogRecord,
} from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Stub `fetch` so the `_apl` POST returns a column-oriented tabular response. */
function stubAplFetch(rows: Array<Record<string, unknown>>): void {
  const names = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const fields = names.map((name) => ({ name, type: 'string' }));
  const columns = names.map((name) => rows.map((r) => r[name]));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ tables: [{ name: '0', fields, columns }] }), { status: 200 })),
  );
}

function provider(): AxiomProvider {
  const client = new AxiomClient({ token: 't', dataset: 'logs' });
  return new AxiomProvider(client, { dataset: 'logs' });
}

describe('AxiomProvider.queryEvidence', () => {
  it('turns each row into kind:log Evidence with the row fields on the payload', async () => {
    stubAplFetch([
      {
        _time: '2026-06-22T10:00:00Z',
        level: 'error',
        message: 'checkout failed: timeout',
        service: 'payments',
      },
    ]);
    const ev = await provider().queryEvidence({ collectedAt: '2026-06-22T12:00:00Z' });

    expect(ev).toHaveLength(1);
    const e = ev[0]!;
    expect(e.id).toBe('ev_axiom_0');
    expect(e.kind).toBe('log');
    expect(e.source).toBe('logs'); // folds into the engine's log evidence path
    const p = e.payload as Record<string, unknown>;
    expect(p['source']).toBe('axiom');
    expect(p['dataset']).toBe('logs');
    expect(p['message']).toBe('checkout failed: timeout');
    expect(p['service']).toBe('payments');
    expect(e.title).toContain('checkout failed');
    expect(e.timestamp).toBe('2026-06-22T10:00:00Z');
    expect(e.provenance.collectedAt).toBe('2026-06-22T12:00:00Z');
    // priority/category/subject are NOT set by the provider.
    expect(e.priority).toBeUndefined();
    expect(e.category).toBeUndefined();
    expect(e.subject).toBeUndefined();
  });

  it('degrades to [] (never throws) when the query call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(provider().queryEvidence()).resolves.toEqual([]);
  });
});

describe('computeRelevance (hint-term match + recency + level)', () => {
  const fresh: AxiomLogRecord = {
    timestamp: new Date().toISOString(),
    fields: { level: 'error', message: 'BrandService sync failed', service: 'brand' },
  };

  it('boosts when a hint term matches a field', () => {
    const matched = computeRelevance(fresh, ['brand']);
    const unmatched = computeRelevance(fresh, ['payment']);
    expect(matched).toBeGreaterThan(unmatched);
  });

  it('weights recent error rows higher than stale info ones', () => {
    const stale: AxiomLogRecord = {
      timestamp: '2020-01-01T00:00:00Z',
      fields: { level: 'info', message: 'ok' },
    };
    expect(computeRelevance(fresh, [])).toBeGreaterThan(computeRelevance(stale, []));
  });

  it('stays within [0.5, 0.95]', () => {
    const r = computeRelevance(fresh, ['brand', 'service']);
    expect(r).toBeGreaterThanOrEqual(0.5);
    expect(r).toBeLessThanOrEqual(0.95);
  });
});

describe('buildTitle', () => {
  it('renders a self-contained one-liner with level, message, and timestamp', () => {
    const title = buildTitle(
      { timestamp: '2026-06-22T10:00:00Z', fields: { level: 'error', message: 'boom' } },
      'logs',
    );
    expect(title).toContain('Axiom logs');
    expect(title).toContain('[error]');
    expect(title).toContain('boom');
  });

  it('falls back to a placeholder when no message field exists', () => {
    const title = buildTitle({ fields: { foo: 'bar' } }, 'logs');
    expect(title).toContain('(log event)');
  });
});

describe('AxiomProvider identity + health', () => {
  it('is a logs-kind provider that delegates health to the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const p = provider();
    expect(p.id).toBe('axiom');
    expect(p.kind).toBe('logs');
    const h = await p.health();
    expect(h.ok).toBe(true);
  });
});
