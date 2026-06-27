/**
 * HOR-32 — Unit tests for renderOnboarding (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { Symbol } from '@horus/core';
import type { OnboardingGuide } from './onboard.js';
import { renderOnboarding } from './render-onboard.js';
import { buildAreaTokens, bestAreaSymbol, filterArchitecture } from './onboard.js';

// ---------------------------------------------------------------------------
// Synthetic fixture
// ---------------------------------------------------------------------------

function makeGuide(): OnboardingGuide {
  return {
    area: 'payments',
    architecture: {
      nodeStats: [{ label: 'File', count: 42 }],
      subsystems: [{ name: 'billing-core', members: 18 }],
      asyncBoundaries: [
        {
          queueName: 'invoice-queue',
          producers: [{ symbol: 'InvoiceService', file: null }],
          workers: [{ symbol: 'InvoiceWorker', file: null }],
        },
      ],
      keyFlows: ['checkout-flow'],
      externalSystems: [{ name: 'stripe', files: 5 }],
      fragile: { deadCode: 3, highCouplingPairs: 7 },
      summary: '1 subsystems, 1 async queue boundaries, 1 external systems, 3 dead-code symbols.',
    },
    ownership: {
      query: 'payments',
      symbol: null,
      file: 'src/billing/invoice.ts',
      contributors: [
        {
          author: 'alice@example.com',
          commits: 12,
          firstDate: '2024-01-10',
          lastDate: '2024-05-01',
        },
      ],
      likelyMaintainer: 'alice@example.com',
      maintainerShare: 0.8,
      mostActiveRecent: 'alice@example.com',
      confidence: 0.8,
      evidence: ['12 of 15 commits to src/billing/invoice.ts'],
      note: 'Estimate from git commit history only.',
    },
    pastIncidents: [
      {
        id: 'inv-001',
        title: 'Invoice worker stalled on large batch',
        createdAt: '2024-04-15T10:30:00.000Z',
      },
    ],
    summary:
      'Onboarding for "payments": 1 subsystems (largest billing-core), 1 async queue boundaries, 1 external systems, 1 past investigation(s) on record.',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderOnboarding', () => {
  it('contains all five required section headers', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);

    expect(output).toContain('## How this system works');
    expect(output).toContain('## Critical paths');
    expect(output).toContain('## What usually breaks');
    expect(output).toContain('## Who owns this area');
    expect(output).toContain('## Past incidents');
  });

  it('includes the subsystem name', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('billing-core');
  });

  it('includes the queue name', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('invoice-queue');
  });

  it('includes the maintainer name', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('alice@example.com');
  });

  it('includes the past incident title', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('Invoice worker stalled on large batch');
  });

  it('starts with the onboarding title including area', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('# Onboarding: payments');
  });

  it('shows the summary line', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('Onboarding for "payments"');
  });

  it('renders "none on record" when there are no incidents', () => {
    const guide = makeGuide();
    guide.pastIncidents = [];
    const output = renderOnboarding(guide);
    expect(output).toContain('_none on record_');
  });

  it('renders dim ownership note when ownership is null', () => {
    const guide = makeGuide();
    guide.ownership = null;
    const output = renderOnboarding(guide);
    expect(output).toContain('horus owner <symbol>');
  });

  it('includes the closing deterministic note', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('deterministic, no AI');
  });
});

// ---------------------------------------------------------------------------
// Area-specific filtering helpers (HOR-186)
// ---------------------------------------------------------------------------

function makeSym(name: string, filePath: string): Symbol {
  return { id: 'sym:' + name, name, filePath };
}

describe('buildAreaTokens', () => {
  it('includes tokens from the area string and symbols', () => {
    const tokens = buildAreaTokens('shopify', [
      makeSym('shopifyWebhookHandler', 'src/shopify/webhook.ts'),
    ]);
    expect(tokens.has('shopify')).toBe(true);
    expect(tokens.has('webhook')).toBe(true);
    expect(tokens.has('handler')).toBe(true);
  });
});

describe('bestAreaSymbol', () => {
  it('picks the symbol whose name/path matches the most area tokens', () => {
    const symbols = [
      makeSym('settingsResolver', 'src/resolvers/settings.resolver.ts'),
      makeSym('shopifyWebhookHandler', 'src/shopify/webhook.ts'),
    ];
    const best = bestAreaSymbol('shopify', symbols);
    expect(best).not.toBeNull();
    expect(best!.filePath).toBe('src/shopify/webhook.ts');
  });

  it('returns null when no symbols are provided', () => {
    expect(bestAreaSymbol('shopify', [])).toBeNull();
  });
});

describe('filterArchitecture', () => {
  it('keeps only architecture components whose names overlap with area tokens', () => {
    const architecture = {
      nodeStats: [],
      subsystems: [
        { name: 'shopify-core', members: 12 },
        { name: 'billing-core', members: 18 },
      ],
      asyncBoundaries: [
        { queueName: 'shopify-sync', producers: [{ symbol: 'ShopifyProducer', file: null }], workers: [{ symbol: 'ShopifyWorker', file: null }] },
        { queueName: 'invoice-queue', producers: [{ symbol: 'InvoiceService', file: null }], workers: [{ symbol: 'InvoiceWorker', file: null }] },
      ],
      keyFlows: ['shopify-checkout-flow', 'billing-renewal-flow'],
      externalSystems: [
        { name: 'shopify', files: 8 },
        { name: 'stripe', files: 5 },
      ],
      fragile: { deadCode: 3, highCouplingPairs: 7 },
      summary: 'mixed architecture',
    };

    const tokens = buildAreaTokens('shopify', [makeSym('shopifyService', 'src/shopify/service.ts')]);
    const filtered = filterArchitecture(architecture, tokens);

    expect(filtered.subsystems.map((s) => s.name)).toEqual(['shopify-core']);
    expect(filtered.asyncBoundaries.map((b) => b.queueName)).toEqual(['shopify-sync']);
    expect(filtered.keyFlows).toEqual(['shopify-checkout-flow']);
    expect(filtered.externalSystems.map((e) => e.name)).toEqual(['shopify']);
  });
});

describe('renderOnboarding — area-specific filtering', () => {
  it('renders only area-relevant subsystems and boundaries', () => {
    const rawArchitecture = {
      nodeStats: [],
      subsystems: [
        { name: 'shopify-core', members: 12 },
        { name: 'billing-core', members: 18 },
      ],
      asyncBoundaries: [
        { queueName: 'shopify-sync', producers: [{ symbol: 'ShopifyProducer', file: null }], workers: [{ symbol: 'ShopifyWorker', file: null }] },
        { queueName: 'invoice-queue', producers: [{ symbol: 'InvoiceService', file: null }], workers: [{ symbol: 'InvoiceWorker', file: null }] },
      ],
      keyFlows: ['shopify-checkout-flow', 'billing-renewal-flow'],
      externalSystems: [
        { name: 'shopify', files: 8 },
        { name: 'stripe', files: 5 },
      ],
      fragile: { deadCode: 3, highCouplingPairs: 7 },
      summary: 'mixed architecture',
    };

    const tokens = buildAreaTokens('shopify', [
      makeSym('shopifyService', 'src/shopify/service.ts'),
    ]);
    const filteredArchitecture = filterArchitecture(rawArchitecture, tokens);

    const guide: OnboardingGuide = {
      area: 'shopify',
      architecture: filteredArchitecture,
      ownership: null,
      pastIncidents: [],
      summary:
        'Onboarding for "shopify": 1 subsystems (largest shopify-core), 1 async queue boundaries, 1 external systems, 0 past investigation(s) on record. Filtered toward "shopify".',
    };

    const output = renderOnboarding(guide);
    expect(output).toContain('shopify-core');
    expect(output).toContain('shopify-sync');
    expect(output).toContain('shopify-checkout-flow');
    expect(output).toContain('shopify');
    expect(output).not.toContain('billing-core');
    expect(output).not.toContain('invoice-queue');
    expect(output).not.toContain('billing-renewal-flow');
    expect(output).not.toContain('stripe');
    expect(output).toContain('Filtered toward "shopify"');
  });
});
