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

  it('weights source relevance: a strong exact-content match outranks a coincidental service-named seed (gap 3)', () => {
    // A code hint (e.g. HTTPFLT001) resolves to its raise site — a filter `catch` — at search
    // score ~1.0; a coincidental same-named `catch` in a *.service.ts (architectural PREFER +
    // file-suffix) must NOT win now that source relevance is weighted.
    const raiseSite: Symbol = { id: 'm1', name: 'catch', filePath: 'src/common/filters/http-exception.filter.ts', score: 1 };
    const coincidental: Symbol = { id: 'm2', name: 'catch', filePath: 'src/modules/legal/legal.service.ts', score: 0.02 };
    // hintHasCode=true: a code hint makes the exact-content score authoritative.
    const ranked = rankSeeds([coincidental, raiseSite], ['httpflt001'], undefined, true);
    expect(ranked[0]?.symbol.id).toBe('m1');
  });

  it('does NOT let a high-score generic match beat a hint-relevant function for a PROSE hint (gap 3 must not regress seed-emitted cases)', () => {
    // "fulfillment failing for brand orders": the `Brand` schema scores 1.0 (matches "brand")
    // but the real raise site `checkBrandOrderFulfillment` scores 0.03. With no code token the
    // raw score is weighted MILDLY, so hint-tokens + role pick the function.
    const schema: Symbol = { id: 's1', name: 'Brand', filePath: 'src/schemas/brand.schema.ts', score: 1 };
    const fn: Symbol = { id: 's2', name: 'checkBrandOrderFulfillment', filePath: 'src/services/order.service.ts', score: 0.03 };
    const ranked = rankSeeds([schema, fn], ['fulfillment', 'brand', 'orders'], undefined, false);
    expect(ranked[0]?.symbol.id).toBe('s2');
  });

  it('a code hint follows the exact-content raise site, not a same-score service-named co-occurrence (gap 9)', () => {
    // ERR243 resolves to its raise site `createCostAwareLink` in lib/ (exact-content head, earlier
    // in search order); `updateSingleProductQuantity` in a *.service.ts merely co-occurs at the same
    // score. For a code hint the architectural role is suppressed, so the raise site wins.
    const raiseSite: Symbol = { id: 'r1', name: 'createCostAwareLink', filePath: 'src/lib/storeclients.ts', score: 1 };
    const coOccur: Symbol = { id: 'r2', name: 'updateSingleProductQuantity', filePath: 'src/services/product.service.ts', score: 1 };
    const ranked = rankSeeds([raiseSite, coOccur], ['err243'], undefined, true);
    expect(ranked[0]?.symbol.id).toBe('r1');
  });

  it('gap H: a thin boolean predicate (the decision) outranks a presentation builder', () => {
    // "duplicate leads not being detected before pushing" — the detection lives in the 2-line
    // predicate `isDuplicateLeadSet`, but it used to lose to `buildDuplicateLeadMessage` (a Cliq
    // string formatter) because the predicate got the short-symbol getter penalty and the
    // formatter did not. Now the formatter is demoted and the predicate is exempt.
    const formatter: Symbol = {
      id: 'f',
      name: 'buildDuplicateLeadMessage',
      filePath: 'src/modules/zoho/zoho-cliq.service.ts',
      startLine: 155,
      endLine: 178,
    };
    const predicate: Symbol = {
      id: 'p',
      name: 'isDuplicateLeadSet',
      filePath: 'src/modules/zoho/zoho-pusher.service.ts',
      startLine: 673,
      endLine: 675,
    };
    const ranked = rankSeeds([formatter, predicate], ['duplicate', 'leads', 'detected']);
    expect(ranked[0]?.symbol.name).toBe('isDuplicateLeadSet');
  });
});
