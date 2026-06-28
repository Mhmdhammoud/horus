/**
 * Horus Memory M2 — the source-host-backed `MemoryVectorIndex`.
 *
 * This is the concrete implementation swapped in behind the M1 engine seam
 * (`MemoryVectorIndex` in `@horus/engine/src/memory-store.ts`). It bridges to the
 * single-RW-owner host over HTTP (`/api/memory/upsert|search|remove`) where claims
 * are embedded with the SAME nomic model/scheme/cache as code, so link-by-id is
 * semantically meaningful.
 *
 * DEPENDENCY NOTE: `@horus/engine` depends on `@horus/connectors`, so we cannot import
 * the engine's `MemoryVectorIndex`/`VectorHit` here (that would cycle). Instead we
 * declare a STRUCTURAL mirror (`MemoryVectorIndexLike`/`MemoryVectorHit`) — identical
 * shapes — so this class is assignable to the engine seam at the CLI wiring site, and so
 * an injected engine `NoopVectorIndex` satisfies the `fallback` slot by structure.
 *
 * BEST-EFFORT INVARIANT (HARD RULE): every method swallows host failures.
 *   - `search` returns the host hits when present; on host-down / 404 / 503 / timeout, or
 *     when the index is empty, it delegates to the optional Jaccard `fallback` (else `[]`).
 *   - `upsert`/`remove` resolve silently on failure and mirror into the local `fallback`
 *     so a degraded (host-absent) read still has lexical candidates this process.
 * Memory add must NEVER block or throw because of the vector index — recall transparently
 * degrades to the deterministic scope/Jaccard path (memory-recall.ts).
 *
 * LOCAL-ONLY: this index talks only to the local source host; it never touches any
 * cloud-sync path. Vectors are a rebuildable derived index, not a system of record.
 */

import type { SourceHttpClient } from './client.js';

/** A scored candidate. Structural mirror of the engine's `VectorHit`. */
export interface MemoryVectorHit {
  memoryId: string;
  score: number;
}

/**
 * Structural mirror of the engine's `MemoryVectorIndex` seam. Kept in lockstep with
 * `@horus/engine/src/memory-store.ts` — any drift there must be reflected here.
 */
export interface MemoryVectorIndexLike {
  upsert(i: { memoryId: string; claim: string; repo: string; scope: string }): Promise<void>;
  search(i: { query: string; repo: string; limit: number }): Promise<MemoryVectorHit[]>;
  remove(memoryId: string): Promise<void>;
}

export interface SourceMemoryVectorIndexOptions {
  /**
   * Optional local fallback (typically the engine `NoopVectorIndex`). When the host is
   * unreachable or its index is empty, `search` delegates here; `upsert`/`remove` mirror
   * into it so a degraded read still works within this process.
   */
  fallback?: MemoryVectorIndexLike;
}

export class SourceMemoryVectorIndex implements MemoryVectorIndexLike {
  private readonly client: SourceHttpClient;
  private readonly fallback: MemoryVectorIndexLike | undefined;

  constructor(client: SourceHttpClient, opts: SourceMemoryVectorIndexOptions = {}) {
    this.client = client;
    this.fallback = opts.fallback;
  }

  async upsert(i: {
    memoryId: string;
    claim: string;
    repo: string;
    scope: string;
  }): Promise<void> {
    // Mirror into the local fallback first (cheap, in-memory) so a host-down read still
    // has candidates, then push to the host. Both legs are best-effort / non-fatal.
    if (this.fallback) {
      try {
        await this.fallback.upsert(i);
      } catch {
        // ignore — fallback mirroring is best-effort
      }
    }
    try {
      await this.client.memoryUpsert(i);
    } catch {
      // ignore — memory add must never block on vector indexing
    }
  }

  async search(i: { query: string; repo: string; limit: number }): Promise<MemoryVectorHit[]> {
    try {
      const hits = await this.client.memorySearch({
        query: i.query,
        repo: i.repo,
        limit: i.limit,
      });
      // A non-empty host result wins. An empty result (index absent / not yet built)
      // degrades to the local Jaccard fallback so recall still gets candidates.
      if (hits.length > 0) return hits;
      return this.fallbackSearch(i);
    } catch {
      // Host down / 404 / 503 / timeout — degrade to Jaccard (or empty).
      return this.fallbackSearch(i);
    }
  }

  async remove(memoryId: string): Promise<void> {
    if (this.fallback) {
      try {
        await this.fallback.remove(memoryId);
      } catch {
        // ignore — fallback mirroring is best-effort
      }
    }
    try {
      await this.client.memoryRemove(memoryId);
    } catch {
      // ignore — removal is best-effort
    }
  }

  private async fallbackSearch(i: {
    query: string;
    repo: string;
    limit: number;
  }): Promise<MemoryVectorHit[]> {
    if (!this.fallback) return [];
    try {
      return await this.fallback.search(i);
    } catch {
      return [];
    }
  }
}
