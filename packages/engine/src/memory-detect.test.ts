/**
 * Horus Memory M3 — the auto-detection seam (`detectMemoryEdges`, Stage 1a).
 *
 * Stage 1a ships the contract + a side-effect-free entry point: it READS the store (so detection is
 * honestly derived from stored context) and RETURNS proposals — it NEVER writes. Stage 1b fills the
 * recurrence/contradiction heuristics; until then the deterministic result is no proposals.
 */

import { describe, it, expect, vi } from 'vitest';
import { detectMemoryEdges } from './memory-detect.js';
import type { MemoryStore } from './memory-store.js';

function fakeStore(over: Partial<MemoryStore> = {}): MemoryStore {
  return {
    recall: vi.fn(),
    record: vi.fn(),
    loadScoped: vi.fn(),
    add: vi.fn(),
    get: vi.fn(),
    query: vi.fn(async () => []),
    setStatus: vi.fn(),
    setVisibility: vi.fn(),
    verify: vi.fn(),
    addLink: vi.fn(),
    removeLink: vi.fn(),
    links: vi.fn(),
    history: vi.fn(),
    ...over,
  } as MemoryStore;
}

describe('detectMemoryEdges (seam)', () => {
  it('is READ-ONLY: it queries the repo but never writes (no addLink/removeLink/setStatus)', async () => {
    const store = fakeStore();
    const edges = await detectMemoryEdges(store, { repo: 'my-api' });
    expect(edges).toEqual([]);
    expect(store.query).toHaveBeenCalledWith(expect.objectContaining({ repo: 'my-api' }));
    expect(store.addLink).not.toHaveBeenCalled();
    expect(store.removeLink).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it('fails closed on a blank repo (HOR-46) — proposes nothing, never queries', async () => {
    const store = fakeStore();
    const edges = await detectMemoryEdges(store, { repo: '   ' });
    expect(edges).toEqual([]);
    expect(store.query).not.toHaveBeenCalled();
  });
});
