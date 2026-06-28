/**
 * HOR-185 — Regression tests for estimateOwnership file-path resolution.
 * Pure unit tests — connectors are stubbed, no git I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeProvider, FileContributor } from '@horus/connectors';
import type { Symbol } from '@horus/core';

vi.mock('@horus/connectors', () => ({
  gitFileContributors: vi.fn(),
}));

import * as connectors from '@horus/connectors';
import { estimateOwnership, isBotAuthor } from './ownership.js';

describe('isBotAuthor (HOR-369)', () => {
  it('flags bot identities, not humans', () => {
    for (const bot of [
      'github-actions[bot]',
      'dependabot[bot]',
      'renovate[bot]',
      'snyk-bot',
      'semantic-release-bot',
    ]) {
      expect(isBotAuthor(bot)).toBe(true);
    }
    for (const human of ['Mohammad Hammoud', 'alice', 'Sebastián Ramírez', 'bot-builder-jane']) {
      expect(isBotAuthor(human)).toBe(false);
    }
  });

  it('flags additional CI/automation accounts', () => {
    for (const bot of ['pre-commit-ci[bot]', 'dependabot-preview[bot]', 'imgbot', 'whitesource-bolt']) {
      expect(isBotAuthor(bot)).toBe(true);
    }
  });
});

const mockGitFileContributors = vi.mocked(connectors.gitFileContributors);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSymbol(name: string, filePath: string): Symbol {
  return {
    id: 'function:' + name,
    name,
    filePath,
    startLine: 1,
    endLine: 10,
    language: 'typescript',
  };
}

const CONTRIBUTOR: FileContributor = {
  author: 'Mohammad Hammoud',
  commits: 5,
  firstDate: '2025-01-01',
  lastDate: '2026-01-01',
};

function makeCode(results: Symbol[][]): CodeProvider {
  let callCount = 0;
  return {
    health: vi.fn(),
    context: vi.fn(),
    impact: vi.fn(),
    flowsFor: vi.fn(),
    detectChanges: vi.fn(),
    searchSymbols: vi.fn(async () => {
      const r = results[callCount] ?? results[results.length - 1] ?? [];
      callCount++;
      return r;
    }),
  } as unknown as CodeProvider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGitFileContributors.mockResolvedValue([CONTRIBUTOR]);
});

describe('estimateOwnership — file-path queries (HOR-185)', () => {
  it('resolves to the controller file when basename matches exactly', async () => {
    const controllerSym = makeSymbol('handler', 'src/controllers/shopify-app-webhook.controller.ts');
    const routerSym = makeSymbol('router', 'src/routers/shopify-app-webhook.router.ts');

    // Broad search returns both; exact basename match should win
    const code = makeCode([[routerSym, controllerSym]]);

    const o = await estimateOwnership('shopify-app-webhook.controller.ts', {
      code,
      repoPath: '/repo',
    });

    expect(o.file).toBe('src/controllers/shopify-app-webhook.controller.ts');
  });

  it('resolves to the router file when queried by its exact basename', async () => {
    const controllerSym = makeSymbol('handler', 'src/controllers/shopify-app-webhook.controller.ts');
    const routerSym = makeSymbol('router', 'src/routers/shopify-app-webhook.router.ts');

    const code = makeCode([[controllerSym, routerSym]]);

    const o = await estimateOwnership('shopify-app-webhook.router.ts', {
      code,
      repoPath: '/repo',
    });

    expect(o.file).toBe('src/routers/shopify-app-webhook.router.ts');
  });

  it('returns ambiguous candidates when basename matches multiple files', async () => {
    const sym1 = makeSymbol('handlerA', 'src/v1/order.controller.ts');
    const sym2 = makeSymbol('handlerB', 'src/v2/order.controller.ts');

    const code = makeCode([[sym1, sym2]]);

    const o = await estimateOwnership('order.controller.ts', {
      code,
      repoPath: '/repo',
    });

    expect(o.file).toBeNull();
    expect(o.candidates).toHaveLength(2);
    expect(o.candidates).toContain('src/v1/order.controller.ts');
    expect(o.candidates).toContain('src/v2/order.controller.ts');
    expect(o.note).toContain('Ambiguous');
  });

  it('falls back to fuzzy symbol search when no file matches the basename', async () => {
    // Broad search returns symbols from unrelated files; fallback returns top-1 fuzzy
    const fuzzyResult = makeSymbol('OrderProcessor', 'src/order/processor.ts');
    const unrelated = makeSymbol('something', 'src/other/nothing.ts');

    // First call (broad, limit 20): no basename match; second call (fuzzy, limit 5): returns top-1
    const code = makeCode([[unrelated], [fuzzyResult]]);

    const o = await estimateOwnership('order.controller.ts', {
      code,
      repoPath: '/repo',
    });

    expect(o.file).toBe('src/order/processor.ts');
    expect(o.candidates).toBeUndefined();
  });

  it('resolves correctly using a partial path suffix (controllers/shopify-app-webhook.controller.ts)', async () => {
    const controllerSym = makeSymbol('handler', 'src/controllers/shopify-app-webhook.controller.ts');
    const routerSym = makeSymbol('router', 'src/routers/shopify-app-webhook.router.ts');

    const code = makeCode([[routerSym, controllerSym]]);

    const o = await estimateOwnership('controllers/shopify-app-webhook.controller.ts', {
      code,
      repoPath: '/repo',
    });

    expect(o.file).toBe('src/controllers/shopify-app-webhook.controller.ts');
  });

  it('confidence is based on commits to the resolved file', async () => {
    const sym = makeSymbol('handler', 'src/controllers/shopify-app-webhook.controller.ts');
    const code = makeCode([[sym]]);

    mockGitFileContributors.mockResolvedValueOnce([{ author: 'Dev', commits: 8, firstDate: '2025-01-01', lastDate: '2026-01-01' }]);

    const o = await estimateOwnership('shopify-app-webhook.controller.ts', {
      code,
      repoPath: '/repo',
    });

    expect(o.confidence).toBeGreaterThan(0);
    expect(o.likelyMaintainer).toBe('Dev');
  });
});

describe('estimateOwnership — bot author filtering (HOR-369)', () => {
  it('routes to the top human even when a bot has the highest commit share', async () => {
    const sym = makeSymbol('handler', 'src/controllers/shopify-app-webhook.controller.ts');
    const code = makeCode([[sym]]);

    // renovate[bot] dominates the raw commit count; a human must still be chosen.
    mockGitFileContributors.mockResolvedValueOnce([
      { author: 'renovate[bot]', commits: 40, firstDate: '2025-01-01', lastDate: '2026-06-01' },
      { author: 'dependabot[bot]', commits: 25, firstDate: '2025-02-01', lastDate: '2026-05-01' },
      { author: 'Alice Dev', commits: 8, firstDate: '2025-03-01', lastDate: '2026-04-01' },
      { author: 'Bob Maintainer', commits: 3, firstDate: '2025-04-01', lastDate: '2026-03-01' },
    ]);

    const o = await estimateOwnership('shopify-app-webhook.controller.ts', {
      code,
      repoPath: '/repo',
    });

    expect(o.likelyMaintainer).toBe('Alice Dev');
    expect(o.mostActiveRecent).toBe('Alice Dev');
    // Share is computed over HUMAN commits only (8 of 11), never diluted by bot commits.
    expect(o.maintainerShare).toBeCloseTo(8 / 11);
    expect(o.confidence).toBeGreaterThan(0);
    // Full contributor list (including bots) is still returned for evidence.
    expect(o.contributors).toHaveLength(4);
    expect(o.evidence.some((e) => e.includes('human commit'))).toBe(true);
  });

  it('reports ownership unavailable when ONLY bots have touched the file', async () => {
    const sym = makeSymbol('handler', 'src/generated/schema.ts');
    const code = makeCode([[sym]]);

    mockGitFileContributors.mockResolvedValueOnce([
      { author: 'renovate[bot]', commits: 12, firstDate: '2025-01-01', lastDate: '2026-06-01' },
      { author: 'dependabot[bot]', commits: 9, firstDate: '2025-02-01', lastDate: '2026-05-01' },
    ]);

    const o = await estimateOwnership('schema.ts', {
      code,
      repoPath: '/repo',
    });

    expect(o.likelyMaintainer).toBeNull();
    expect(o.mostActiveRecent).toBeNull();
    expect(o.maintainerShare).toBe(0);
    expect(o.confidence).toBe(0);
    expect(o.note).toContain('Only automated/bot contributors');
    // The bot identities are surfaced as evidence but never crowned as maintainer.
    expect(o.contributors).toHaveLength(2);
    expect(o.evidence.join(' ')).toContain('renovate[bot]');
  });

  it('reports no commit history when the file has no contributors at all', async () => {
    const sym = makeSymbol('handler', 'src/empty.ts');
    const code = makeCode([[sym]]);

    mockGitFileContributors.mockResolvedValueOnce([]);

    const o = await estimateOwnership('empty.ts', {
      code,
      repoPath: '/repo',
    });

    expect(o.likelyMaintainer).toBeNull();
    expect(o.confidence).toBe(0);
    expect(o.note).toContain('No commit history');
  });
});

describe('estimateOwnership — symbol queries (unchanged behavior)', () => {
  it('uses fuzzy search for non-file queries (no extension)', async () => {
    const sym = makeSymbol('OrderProcessor', 'src/order/processor.ts');
    const code = makeCode([[sym]]);

    const o = await estimateOwnership('OrderProcessor', {
      code,
      repoPath: '/repo',
    });

    expect(o.file).toBe('src/order/processor.ts');
    expect(o.symbol?.name).toBe('OrderProcessor');
  });

  it('reuses caller-provided symbol without extra search', async () => {
    const sym = makeSymbol('MyService', 'src/my-service.ts');
    const code = makeCode([]);

    const o = await estimateOwnership('MyService', {
      code,
      repoPath: '/repo',
      symbol: sym,
    });

    // searchSymbols must not have been called
    expect(vi.mocked(code.searchSymbols)).not.toHaveBeenCalled();
    expect(o.file).toBe('src/my-service.ts');
  });

  it('returns null file when no symbol matches any query', async () => {
    const code = makeCode([[]]);

    const o = await estimateOwnership('NonExistentClass', {
      code,
      repoPath: '/repo',
    });

    expect(o.file).toBeNull();
    expect(o.confidence).toBe(0);
  });
});
