import { describe, it, expect } from 'vitest';
import type { Symbol } from '@horus/core';
import { rankSeeds, seedRole, scoreSeed, executableBaseName } from './seeds.js';

function sym(name: string, filePath: string): Symbol {
  return { id: `x:${filePath}:${name}`, name, filePath };
}

// The exact seeds from the maison "orders are slow" run.
const SEEDS: Symbol[] = [
  sym('inferSupplierScopeFromLegacyOrder', 'src/utils/orderSupplierScope.ts'),
  sym('OrderResolver', 'src/resolvers/order.resolver.ts'),
  sym('sortReplica', 'src/services/sale.service.ts'),
  sym('run', 'scripts/backfill-order-supplier-scope.ts'),
  sym('getRecentOrders', 'src/services/order-analytics.service.ts'),
];

describe('seedRole', () => {
  it('labels architectural roles', () => {
    expect(seedRole(SEEDS[1]!)).toBe('resolver');
    expect(seedRole(SEEDS[2]!)).toBe('service');
    expect(seedRole(SEEDS[0]!)).toBe('util');
    expect(seedRole(SEEDS[3]!)).toBe('script');
  });
});

describe('rankSeeds', () => {
  it('prefers resolver/service entry points over utils and scripts', () => {
    const ranked = rankSeeds(SEEDS);
    expect(ranked[0]?.symbol.name).toBe('OrderResolver');
    // util + script should rank last
    const order = ranked.map((r) => r.symbol.name);
    expect(order.indexOf('OrderResolver')).toBeLessThan(
      order.indexOf('inferSupplierScopeFromLegacyOrder'),
    );
    expect(order.indexOf('run')).toBe(order.length - 1); // the backfill script is last
  });

  it('ranks an executable method above a same-named …Result type (HOR-337)', () => {
    const method = sym('syncBrandFulfillments', 'src/services/order.service.ts');
    const resultType = sym('SyncBrandFulfillmentsResult', 'src/services/order.service.ts');
    expect(scoreSeed(method, 1)).toBeGreaterThan(scoreSeed(resultType, 0));
    // even when the type comes first in search order, the method should win the rank
    const ranked = rankSeeds([resultType, method]);
    expect(ranked[0]?.symbol.name).toBe('syncBrandFulfillments');
  });

  it('derives the executable counterpart name for type-like names (HOR-337)', () => {
    expect(executableBaseName('SyncBrandFulfillmentsResult')).toBe('SyncBrandFulfillments');
    expect(executableBaseName('CreateOrderInput')).toBe('CreateOrder');
    expect(executableBaseName('IOrderService')).toBe('OrderService');
    expect(executableBaseName('syncProduct')).toBeNull(); // already executable
  });

  it('demotes a thin getter below the real method (HOR-337)', () => {
    const getter: Symbol = {
      id: 'x:getter',
      name: 'shopifyClientId',
      filePath: 'src/resolvers/brand.resolver.ts',
      startLine: 267,
      endLine: 270, // 4-line field-resolver
    };
    const service: Symbol = {
      id: 'x:svc',
      name: 'exchangeToken',
      filePath: 'src/services/shopify-token-manager.service.ts',
      startLine: 410,
      endLine: 508,
    };
    expect(scoreSeed(service, 1)).toBeGreaterThan(scoreSeed(getter, 0));
  });

  it('boosts a seed that lives in a --since changed file (HOR-328)', () => {
    const s = sym('Foo', 'src/services/sale.service.ts');
    const changedFiles = new Set(['src/services/sale.service.ts']);
    expect(scoreSeed(s, 0, [], changedFiles)).toBeGreaterThan(scoreSeed(s, 0, []));
  });

  it('a changed-file seed outranks an otherwise-equal unchanged one (HOR-328)', () => {
    const changed = sym('AService', 'src/services/a.service.ts');
    const unchanged = sym('BService', 'src/services/b.service.ts');
    // Without a change set they tie → search order keeps BService first; the change set flips it.
    const ranked = rankSeeds([unchanged, changed], undefined, new Set(['src/services/a.service.ts']));
    expect(ranked[0]?.symbol.name).toBe('AService');
  });

  it('scores a resolver above a util', () => {
    expect(scoreSeed(SEEDS[1]!, 1)).toBeGreaterThan(scoreSeed(SEEDS[0]!, 0));
  });

  it('is stable for equal scores (search order preserved)', () => {
    const a = sym('aService', 'src/services/a.service.ts');
    const b = sym('bService', 'src/services/b.service.ts');
    expect(rankSeeds([a, b]).map((r) => r.symbol.name)).toEqual(['aService', 'bService']);
  });

  it('hint tokens boost domain-specific symbols above generic architectural matches', () => {
    // Without hint tokens, BrandService (service bonus) can beat ShopifyWebhookRegistrationService
    // if it appears earlier in search results. With hint tokens it should always lose.
    const brandService = sym('BrandService', 'src/services/brand.service.ts');
    const shopifyController = sym('ShopifyWebhookRegistrationService', 'src/shopify/shopify-app-webhook.controller.ts');
    const hintTokens = ['shopify', 'webhook', 'uninstall'];
    const ranked = rankSeeds([brandService, shopifyController], hintTokens);
    expect(ranked[0]?.symbol.name).toBe('ShopifyWebhookRegistrationService');
  });
});
