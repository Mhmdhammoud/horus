/**
 * Unit tests for the M1 memory seam's `NoopVectorIndex` (Jaccard/scope, no embeddings, no I/O).
 *
 * These lock the deterministic behaviour the recall layer relies on: repo-scoped fail-closed
 * filtering (HOR-46), Jaccard token ranking, and the scope-specificity tie-break.
 */

import { describe, it, expect } from 'vitest';
import { NoopVectorIndex, tokenize, scopeSpecificity } from './memory-store.js';

async function seed(entries: Array<{ memoryId: string; claim: string; repo: string; scope: string }>) {
  const idx = new NoopVectorIndex();
  for (const e of entries) await idx.upsert(e);
  return idx;
}

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, and de-duplicates', () => {
    expect(tokenize('Retry-Storm in Zoho.Service')).toEqual(['retry', 'storm', 'in', 'zoho', 'service']);
  });

  it('returns [] for empty / symbol-only text', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('---  ///')).toEqual([]);
  });
});

describe('scopeSpecificity', () => {
  it('ranks symbol > module > repo > global', () => {
    expect(scopeSpecificity('symbol:Func:a.ts:foo')).toBe(3);
    expect(scopeSpecificity('module:billing')).toBe(2);
    expect(scopeSpecificity('repo')).toBe(1);
    expect(scopeSpecificity('global')).toBe(0);
    expect(scopeSpecificity('whatever')).toBe(0);
  });
});

describe('NoopVectorIndex', () => {
  it('ranks candidates by Jaccard token overlap, descending', async () => {
    const idx = await seed([
      { memoryId: 'a', claim: 'queue backlog in billing worker', repo: 'r', scope: 'repo' },
      { memoryId: 'b', claim: 'billing worker timeout', repo: 'r', scope: 'repo' },
      { memoryId: 'c', claim: 'totally unrelated thing', repo: 'r', scope: 'repo' },
    ]);

    const hits = await idx.search({ query: 'billing worker backlog', repo: 'r', limit: 10 });

    // 'a' shares the most tokens (billing, worker, backlog) -> highest; 'c' shares none -> dropped.
    expect(hits.map((h) => h.memoryId)).toEqual(['a', 'b']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('breaks Jaccard ties by scope specificity (narrowest first)', async () => {
    // Identical claims => identical Jaccard score; only scope differs.
    const claim = 'auth token refresh failure';
    const idx = await seed([
      { memoryId: 'global1', claim, repo: 'r', scope: 'global' },
      { memoryId: 'symbol1', claim, repo: 'r', scope: 'symbol:Func:auth.ts:refresh' },
      { memoryId: 'module1', claim, repo: 'r', scope: 'module:auth' },
    ]);

    const hits = await idx.search({ query: claim, repo: 'r', limit: 10 });

    expect(hits.map((h) => h.memoryId)).toEqual(['symbol1', 'module1', 'global1']);
    // Same Jaccard for all three.
    expect(new Set(hits.map((h) => h.score)).size).toBe(1);
  });

  it('breaks full ties (score + scope) by memoryId for determinism', async () => {
    const claim = 'cache eviction storm';
    const idx = await seed([
      { memoryId: 'z', claim, repo: 'r', scope: 'repo' },
      { memoryId: 'a', claim, repo: 'r', scope: 'repo' },
      { memoryId: 'm', claim, repo: 'r', scope: 'repo' },
    ]);

    const hits = await idx.search({ query: claim, repo: 'r', limit: 10 });
    expect(hits.map((h) => h.memoryId)).toEqual(['a', 'm', 'z']);
  });

  it('fails closed: only the query repo is searched (HOR-46)', async () => {
    const idx = await seed([
      { memoryId: 'mine', claim: 'shared name', repo: 'repo-a', scope: 'repo' },
      { memoryId: 'theirs', claim: 'shared name', repo: 'repo-b', scope: 'repo' },
    ]);

    const hits = await idx.search({ query: 'shared name', repo: 'repo-a', limit: 10 });
    expect(hits.map((h) => h.memoryId)).toEqual(['mine']);
  });

  it('returns [] for a blank repo or empty query', async () => {
    const idx = await seed([{ memoryId: 'a', claim: 'x y z', repo: 'r', scope: 'repo' }]);
    expect(await idx.search({ query: 'x y z', repo: '   ', limit: 10 })).toEqual([]);
    expect(await idx.search({ query: '   ', repo: 'r', limit: 10 })).toEqual([]);
  });

  it('honors the limit', async () => {
    const idx = await seed([
      { memoryId: 'a', claim: 'one two three', repo: 'r', scope: 'repo' },
      { memoryId: 'b', claim: 'one two', repo: 'r', scope: 'repo' },
      { memoryId: 'c', claim: 'one', repo: 'r', scope: 'repo' },
    ]);
    const hits = await idx.search({ query: 'one two three', repo: 'r', limit: 2 });
    expect(hits.map((h) => h.memoryId)).toEqual(['a', 'b']);
  });

  it('upsert replaces a prior claim for the same memoryId; remove drops it', async () => {
    const idx = new NoopVectorIndex();
    await idx.upsert({ memoryId: 'a', claim: 'apples oranges', repo: 'r', scope: 'repo' });
    await idx.upsert({ memoryId: 'a', claim: 'bananas grapes', repo: 'r', scope: 'repo' });

    expect((await idx.search({ query: 'apples', repo: 'r', limit: 5 })).length).toBe(0);
    expect((await idx.search({ query: 'bananas', repo: 'r', limit: 5 })).map((h) => h.memoryId)).toEqual(['a']);

    await idx.remove('a');
    expect(await idx.search({ query: 'bananas', repo: 'r', limit: 5 })).toEqual([]);
  });
});
