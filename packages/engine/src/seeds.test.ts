import { describe, it, expect } from 'vitest';
import type { Symbol } from '@horus/core';
import {
  rankSeeds,
  seedRole,
  scoreSeed,
  executableBaseName,
  parseSeedQualifier,
  qualifierBoost,
} from './seeds.js';

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

describe('rankSeeds — a real candidate beats a hint-hugging test fixture (HOR-376)', () => {
  it('hard-demotes test/fixture paths below real source when a real candidate exists', () => {
    const fixture = sym('Model', 'tests/mypy/modules/plugin_fail.py'); // name hugs the hint
    const real = sym('build_schema', 'pydantic/_internal/_core_utils.py'); // weaker name match
    const hint = ['model', 'validation', 'recursion'];
    expect(rankSeeds([fixture, real], hint).map((r) => r.symbol.name)[0]).toBe('build_schema');
  });

  it('still allows a test seed when every candidate is a test (test-only repo)', () => {
    const t1 = sym('test_alpha', 'tests/test_alpha.py');
    const t2 = sym('test_beta', 'tests/test_beta.py');
    expect(rankSeeds([t1, t2], ['alpha']).map((r) => r.symbol.name)[0]).toBe('test_alpha');
  });
});

describe('scoreSeed — test files demoted below the implementation (HOR-361)', () => {
  it('ranks the implementation above a same-topic test (tests/ + test_x.py)', () => {
    const impl = sym('login', 'backend/app/api/routes/login.py');
    const test = sym('test_login_incorrect_password', 'backend/tests/api/routes/test_login.py');
    const hint = ['login'];
    expect(scoreSeed(impl, 1, hint)).toBeGreaterThan(scoreSeed(test, 0, hint));
    expect(rankSeeds([test, impl], hint).map((r) => r.symbol.name)[0]).toBe('login');
  });

  it('demotes the test path conventions DEMOTE\\b misses', () => {
    const impl = sym('handler', 'src/app/handler.ts');
    const hint = ['handler'];
    for (const p of [
      'src/__tests__/handler.ts',
      'src/app/handler.test.ts',
      'src/app/handler.spec.ts',
      'tests/test_handler.py',
      'app/handler_test.py',
    ]) {
      expect(scoreSeed(sym('handler', p), 0, hint)).toBeLessThan(scoreSeed(impl, 0, hint));
    }
  });

  it('demotes examples/docs/tutorial files below real source (HOR-365)', () => {
    // sqlmodel: real ORM `Relationship` should beat the tutorial `Relationship` example.
    const impl = sym('Relationship', 'sqlmodel/main.py');
    const hint = ['relationship'];
    for (const p of [
      'docs_src/tutorial/relationship_attributes/tutorial001.py',
      'examples/web-service/index.js',
      'example/app.py',
      'samples/demo.ts',
      'docs/snippets/usage.py',
    ]) {
      expect(scoreSeed(sym('Relationship', p), 0, hint)).toBeLessThan(scoreSeed(impl, 0, hint));
    }
    expect(
      rankSeeds(
        [sym('Relationship', 'docs_src/tutorial/read_relationships/tutorial001.py'), impl],
        hint,
      ).map((r) => r.symbol.filePath)[0],
    ).toBe('sqlmodel/main.py');
  });
});

describe('parseSeedQualifier (HOR-337)', () => {
  it('parses Class.method into container + symbol', () => {
    expect(parseSeedQualifier('ProductService.syncProduct is failing')).toEqual({
      symbol: 'syncProduct',
      container: 'ProductService',
      isPath: false,
    });
  });

  it('parses path/to/file:symbol into container path + symbol', () => {
    expect(parseSeedQualifier('error in src/services/product.service.ts:syncProduct')).toEqual({
      symbol: 'syncProduct',
      container: 'src/services/product.service.ts',
      isPath: true,
    });
  });

  it('does not treat a lowercase obj.method or a bare file.ext as a Class.method qualifier', () => {
    expect(parseSeedQualifier('the order.total is wrong')).toBeNull();
    expect(parseSeedQualifier('see config.ts for details')).toBeNull();
  });

  it('ignores single-letter containers/symbols (e.g. U.S.)', () => {
    expect(parseSeedQualifier('the U.S. region is down')).toBeNull();
  });

  it('returns null for an unqualified prose hint', () => {
    expect(parseSeedQualifier('orders are slow in production')).toBeNull();
  });
});

describe('qualifierBoost (HOR-337)', () => {
  const q = parseSeedQualifier('ProductService.syncProduct')!;

  it('decisively boosts the exact name + class-file match', () => {
    const exact = sym('syncProduct', 'src/services/product.service.ts');
    expect(qualifierBoost(exact, q)).toBeGreaterThan(40);
  });

  it('matches the container via className', () => {
    const s: Symbol = { id: 'c', name: 'syncProduct', filePath: 'src/sync.ts', className: 'ProductService' };
    expect(qualifierBoost(s, q)).toBeGreaterThan(40);
  });

  it('only mildly boosts a same-named symbol in an unrelated container', () => {
    const wrong = sym('syncProduct', 'src/jobs/inventory-sync.ts');
    const boost = qualifierBoost(wrong, q);
    expect(boost).toBeGreaterThan(0);
    expect(boost).toBeLessThan(40);
  });

  it('does not boost a different symbol name', () => {
    expect(qualifierBoost(sym('syncOrder', 'src/services/product.service.ts'), q)).toBe(0);
  });
});

describe('rankSeeds — Class.method / path:symbol EXACT disambiguator (HOR-337)', () => {
  it('resolves ProductService.syncProduct to that exact method, not an unrelated same-named symbol', () => {
    // The exact method lives in a plainly-named runner (no service suffix) but its className is
    // ProductService; the unrelated one sits in a *.service.ts (architectural role + suffix boost).
    const exact: Symbol = {
      id: 'exact',
      name: 'syncProduct',
      filePath: 'src/sync/product-sync-runner.ts',
      className: 'ProductService',
    };
    const unrelated = sym('syncProduct', 'src/services/catalog.service.ts');
    const q = parseSeedQualifier('ProductService.syncProduct')!;
    // Without the qualifier the unrelated *.service.ts wins on role; the qualifier flips it.
    expect(rankSeeds([unrelated, exact], ['syncproduct'])[0]?.symbol.id).toBe(unrelated.id);
    const ranked = rankSeeds([unrelated, exact], ['syncproduct'], undefined, false, q);
    expect(ranked[0]?.symbol.id).toBe('exact');
  });

  it('prefers the path-qualified symbol over a same-named one elsewhere', () => {
    const target = sym('handle', 'src/modules/billing/billing.controller.ts');
    const other = sym('handle', 'src/modules/auth/auth.controller.ts');
    const q = parseSeedQualifier('src/modules/billing/billing.controller.ts:handle')!;
    const ranked = rankSeeds([other, target], ['handle'], undefined, false, q);
    expect(ranked[0]?.symbol.filePath).toBe('src/modules/billing/billing.controller.ts');
  });

  it('uses the signature reference to disambiguate when the file path does not contain Foo', () => {
    const exact: Symbol = {
      id: 'a',
      name: 'syncProduct',
      filePath: 'src/sync/runner.ts',
      signature: 'class ProductService { syncProduct(): Promise<void> }',
    };
    const unrelated = sym('syncProduct', 'src/jobs/inventory.ts');
    const q = parseSeedQualifier('ProductService.syncProduct')!;
    const ranked = rankSeeds([unrelated, exact], ['syncproduct'], undefined, false, q);
    expect(ranked[0]?.symbol.id).toBe('a');
  });

  it('does not change ranking when no qualifier is present (no regression)', () => {
    const a = sym('syncProduct', 'src/jobs/inventory-sync.worker.ts');
    const b = sym('syncProduct', 'src/services/product.service.ts');
    const ranked = rankSeeds([a, b], ['syncproduct']);
    // service-suffix beats a plain worker file here; qualifier-free behaviour is unchanged.
    expect(ranked[0]?.symbol.filePath).toBe('src/services/product.service.ts');
  });
});

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
