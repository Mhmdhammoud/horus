/**
 * SourceMemoryVectorIndex (M2) unit tests — verify the host-bridge happy path and the
 * best-effort degradation contract:
 *   - search returns host hits when present;
 *   - search degrades to the injected Jaccard fallback when the host throws OR returns empty;
 *   - search never throws (returns [] when no fallback);
 *   - upsert/remove call the host, mirror into the fallback, and swallow host errors.
 *
 * The client is mocked; no real HTTP. A tiny in-memory `FakeFallback` stands in for the
 * engine `NoopVectorIndex` (which connectors cannot import without a dependency cycle).
 */

import { describe, it, expect, vi } from 'vitest';
import { SourceMemoryVectorIndex } from './memory-index.js';
import type { MemoryVectorHit, MemoryVectorIndexLike } from './memory-index.js';
import type { SourceHttpClient } from './client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a partial SourceHttpClient exposing only the memory bridge methods. */
function fakeClient(overrides: Partial<SourceHttpClient>): SourceHttpClient {
  return {
    async memoryUpsert() {},
    async memorySearch() {
      return [];
    },
    async memoryRemove() {},
    ...overrides,
  } as unknown as SourceHttpClient;
}

/** In-memory stand-in for the engine NoopVectorIndex (records calls; returns canned hits). */
class FakeFallback implements MemoryVectorIndexLike {
  upserts: { memoryId: string; claim: string; repo: string; scope: string }[] = [];
  removed: string[] = [];
  searchHits: MemoryVectorHit[] = [];

  async upsert(i: { memoryId: string; claim: string; repo: string; scope: string }): Promise<void> {
    this.upserts.push(i);
  }
  async search(): Promise<MemoryVectorHit[]> {
    return this.searchHits;
  }
  async remove(memoryId: string): Promise<void> {
    this.removed.push(memoryId);
  }
}

// ---------------------------------------------------------------------------
// search — happy path
// ---------------------------------------------------------------------------

describe('SourceMemoryVectorIndex.search — happy path', () => {
  it('returns host hits and does not consult the fallback', async () => {
    const hostHits: MemoryVectorHit[] = [
      { memoryId: 'm1', score: 0.9 },
      { memoryId: 'm2', score: 0.5 },
    ];
    const memorySearch = vi.fn().mockResolvedValue(hostHits);
    const fallback = new FakeFallback();
    fallback.searchHits = [{ memoryId: 'should-not-appear', score: 1 }];

    const index = new SourceMemoryVectorIndex(fakeClient({ memorySearch }), { fallback });
    const out = await index.search({ query: 'why null', repo: 'acme/api', limit: 10 });

    expect(out).toEqual(hostHits);
    expect(memorySearch).toHaveBeenCalledWith({ query: 'why null', repo: 'acme/api', limit: 10 });
  });
});

// ---------------------------------------------------------------------------
// search — degradation
// ---------------------------------------------------------------------------

describe('SourceMemoryVectorIndex.search — fallback degradation', () => {
  it('falls back to Jaccard when the host throws', async () => {
    const memorySearch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const fallback = new FakeFallback();
    fallback.searchHits = [{ memoryId: 'jaccard1', score: 0.3 }];

    const index = new SourceMemoryVectorIndex(fakeClient({ memorySearch }), { fallback });
    const out = await index.search({ query: 'q', repo: 'acme/api', limit: 5 });

    expect(out).toEqual([{ memoryId: 'jaccard1', score: 0.3 }]);
  });

  it('falls back to Jaccard when the host index is empty', async () => {
    const memorySearch = vi.fn().mockResolvedValue([]);
    const fallback = new FakeFallback();
    fallback.searchHits = [{ memoryId: 'jaccard2', score: 0.4 }];

    const index = new SourceMemoryVectorIndex(fakeClient({ memorySearch }), { fallback });
    const out = await index.search({ query: 'q', repo: 'acme/api', limit: 5 });

    expect(out).toEqual([{ memoryId: 'jaccard2', score: 0.4 }]);
  });

  it('returns [] (never throws) when the host throws and there is no fallback', async () => {
    const memorySearch = vi.fn().mockRejectedValue(new Error('boom'));
    const index = new SourceMemoryVectorIndex(fakeClient({ memorySearch }));

    await expect(index.search({ query: 'q', repo: 'acme/api', limit: 5 })).resolves.toEqual([]);
  });

  it('returns [] when the fallback itself throws', async () => {
    const memorySearch = vi.fn().mockRejectedValue(new Error('host down'));
    const fallback: MemoryVectorIndexLike = {
      async upsert() {},
      async search() {
        throw new Error('fallback exploded');
      },
      async remove() {},
    };
    const index = new SourceMemoryVectorIndex(fakeClient({ memorySearch }), { fallback });

    await expect(index.search({ query: 'q', repo: 'acme/api', limit: 5 })).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// upsert / remove — best-effort + mirror
// ---------------------------------------------------------------------------

describe('SourceMemoryVectorIndex.upsert', () => {
  it('calls the host and mirrors into the fallback', async () => {
    const memoryUpsert = vi.fn().mockResolvedValue(undefined);
    const fallback = new FakeFallback();
    const index = new SourceMemoryVectorIndex(fakeClient({ memoryUpsert }), { fallback });

    const item = { memoryId: 'm1', claim: 'X is null when Y', repo: 'acme/api', scope: 'repo' };
    await index.upsert(item);

    expect(memoryUpsert).toHaveBeenCalledWith(item);
    expect(fallback.upserts).toEqual([item]);
  });

  it('resolves silently when the host throws (never blocks memory add)', async () => {
    const memoryUpsert = vi.fn().mockRejectedValue(new Error('503'));
    const fallback = new FakeFallback();
    const index = new SourceMemoryVectorIndex(fakeClient({ memoryUpsert }), { fallback });

    const item = { memoryId: 'm1', claim: 'c', repo: 'acme/api', scope: 'repo' };
    await expect(index.upsert(item)).resolves.toBeUndefined();
    // Fallback still mirrored even though the host failed.
    expect(fallback.upserts).toEqual([item]);
  });
});

describe('SourceMemoryVectorIndex.remove', () => {
  it('calls the host and mirrors into the fallback', async () => {
    const memoryRemove = vi.fn().mockResolvedValue(undefined);
    const fallback = new FakeFallback();
    const index = new SourceMemoryVectorIndex(fakeClient({ memoryRemove }), { fallback });

    await index.remove('m1');

    expect(memoryRemove).toHaveBeenCalledWith('m1');
    expect(fallback.removed).toEqual(['m1']);
  });

  it('resolves silently when the host throws', async () => {
    const memoryRemove = vi.fn().mockRejectedValue(new Error('host down'));
    const index = new SourceMemoryVectorIndex(fakeClient({ memoryRemove }));

    await expect(index.remove('m1')).resolves.toBeUndefined();
  });
});
