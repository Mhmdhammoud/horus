import { describe, it, expect } from 'vitest';
import type { Symbol } from '@horus/core';
import { rankSeeds, seedRole, scoreSeed } from './seeds.js';

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
