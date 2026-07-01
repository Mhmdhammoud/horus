/**
 * Integration test: investigate() with Shopify Admin state evidence.
 *
 * Exercises the Shopify branch of the engine end-to-end using the REAL ShopifyProvider
 * over a fake client (no network / DB I/O). The query is supplied at invocation
 * (`input.shopifyQueries`) or falls back to the connector's config-declared defaults
 * (the `horus watch` path); each result folds into one `kind: 'state'` Evidence, and a
 * failing query must never abort the investigation.
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult, Evidence } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import { ShopifyProvider, ShopifyAdminClient } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import { investigate } from './engine.js';

const FAKE_SYMBOL: Symbol = {
  id: 'sym:fake:OrdersService',
  name: 'OrdersService',
  filePath: 'src/services/orders.service.ts',
  startLine: 10,
};

const FAKE_CTX: SymbolContext = {
  symbol: FAKE_SYMBOL,
  callers: [],
  callees: [],
  imports: [],
  usesType: [],
  community: null,
  coupledWith: [],
};

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() {
    return { ok: true, detail: 'fake code provider' };
  },
  async searchSymbols(): Promise<Symbol[]> {
    return [FAKE_SYMBOL];
  },
  async context(): Promise<SymbolContext> {
    return FAKE_CTX;
  },
  async impact(): Promise<ImpactResult> {
    return { target: FAKE_SYMBOL, affected: 0, byDepth: [] };
  },
  async flowsFor() {
    return [];
  },
  async detectChanges(): Promise<ChangeSet> {
    return { added: [], removed: [], modified: [] };
  },
  async cypher(): Promise<CypherResult> {
    return { columns: [], rows: [], rowCount: 0 };
  },
};

const fakeDb = {
  select() {
    return { from() { return Promise.resolve([]); } };
  },
  insert() {
    return {
      values() {
        return {
          returning(): Promise<{ id: string }[]> {
            return Promise.resolve([{ id: globalThis.crypto.randomUUID() }]);
          },
        };
      },
    };
  },
  update() {
    return { set() { return { where(): Promise<void> { return Promise.resolve(); } }; } };
  },
} as unknown as HorusDb;

/** Real ShopifyProvider over a fake client. `graphql` maps each query to canned data. */
function shopifyWith(
  graphql: (query: string) => Promise<{ data?: unknown; errors?: Array<{ message: string }> }>,
  opts: { store?: string; queries?: ConstructorParameters<typeof ShopifyProvider>[1]['queries'] } = {},
): ShopifyProvider {
  const client = { graphql } as unknown as ShopifyAdminClient;
  return new ShopifyProvider(client, {
    store: opts.store ?? 'acme.myshopify.com',
    ...(opts.queries !== undefined ? { queries: opts.queries } : {}),
  });
}

function findShopifyEvidence(evidence: Evidence[]): Evidence | undefined {
  return evidence.find(
    (e) => e.source === 'state' && (e.payload as Record<string, unknown>)?.['source'] === 'shopify',
  );
}

describe('investigate() WITH Shopify provider', () => {
  it('folds an invocation-supplied query result into state evidence tagged source=shopify', async () => {
    const shopify = shopifyWith(async () => ({
      data: { orders: { edges: [{ node: { id: '1' } }, { node: { id: '2' } }] } },
    }));

    const report = await investigate(
      {
        hint: 'orders',
        shopifyQueries: [{ name: 'recent-orders', query: '{ orders { edges { node { id } } } }', kind: 'state' }],
      },
      { code: fakeCode, db: fakeDb, shopify },
    );

    const ev = findShopifyEvidence(report.evidence);
    expect(ev).toBeDefined();
    expect(ev?.kind).toBe('state');
    expect(ev?.title).toContain('recent-orders');
    expect(ev?.title).toContain('2 results');
    expect((ev?.payload as Record<string, unknown>)['shop']).toBe('acme.myshopify.com');
    expect(ev?.provenance.query).toBe('shopify acme.myshopify.com recent-orders');
  });

  it('falls back to config-declared default queries when none are supplied (watch path)', async () => {
    const shopify = shopifyWith(async () => ({ data: { shop: { name: 'Acme' } } }), {
      queries: [{ name: 'shop', query: '{ shop { name } }', kind: 'state' }],
    });

    // No shopifyQueries in the input — mirrors `horus watch`.
    const report = await investigate({ hint: 'orders' }, { code: fakeCode, db: fakeDb, shopify });

    const ev = findShopifyEvidence(report.evidence);
    expect(ev).toBeDefined();
    expect(ev?.provenance.query).toBe('shopify acme.myshopify.com shop');
  });

  it('a failing Shopify query never breaks the investigation', async () => {
    const shopify = shopifyWith(async () => {
      throw new Error('shopify 500');
    });

    const report = await investigate(
      { hint: 'orders', shopifyQueries: [{ name: 'boom', query: '{ x }', kind: 'state' }] },
      { code: fakeCode, db: fakeDb, shopify },
    );

    expect(report).toBeDefined();
    expect(findShopifyEvidence(report.evidence)).toBeUndefined();
  });
});

describe('investigate() WITHOUT Shopify provider (regression guard)', () => {
  it('produces no shopify-sourced evidence', async () => {
    const report = await investigate({ hint: 'orders' }, { code: fakeCode, db: fakeDb });
    expect(findShopifyEvidence(report.evidence)).toBeUndefined();
  });
});
