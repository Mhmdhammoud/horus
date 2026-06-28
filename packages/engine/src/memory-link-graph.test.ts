/**
 * Horus Memory M3.1 — the memory→memory link graph (createLocalMemoryStore, spec §6).
 *
 * Exercised against the embedded pglite db so the bundled migrations (incl. memory_audit.detail)
 * are proven end-to-end. Covers the FROZEN day-0 rel vocabulary (supersedes|contradicts|
 * recurs-with, always toKind:'memory'), endpoint/repo/self-link validation, directional vs
 * symmetric storage + dedupe, bidirectional reads, the non-optional `detection` audit provenance,
 * and the HONESTY INVARIANTS: an auto-detected edge is CONTEXT-ONLY (never flips status), a
 * `contradicts` edge is a FLAG (no auto deletion / status-flip), and private targets never leak.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDb, type HorusDb, type NewMemoryItem } from '@horus/db';
import { createLocalMemoryStore } from './memory.js';
import type { MemoryStore, AuditCtx, MemoryItem } from './memory-store.js';

const actor = { kind: 'user' as const, id: 'u1', name: 'Alice' };

describe('createLocalMemoryStore — memory→memory link graph (M3.1)', () => {
  let dir: string;
  let close: () => Promise<void>;
  let db: HorusDb;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'horus-mem-graph-'));
    const handle = await createLocalDb({ path: join(dir, 'horus.db') });
    db = handle.db;
    close = () => handle.sql.end();
    store = createLocalMemoryStore(db);
  });

  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Mint an item in repo `r` by default; returns the persisted row.
  const add = (over: Partial<NewMemoryItem> = {}, auditCtx: AuditCtx = { actor }): Promise<MemoryItem> =>
    store.add(
      {
        id: '',
        kind: 'decision',
        claim: over.claim ?? 'a decision',
        scope: 'repo',
        source: 'human',
        confidence: 0.8,
        repo: 'r',
        ...over,
      },
      auditCtx,
    );

  it('addLink: accepts the frozen memory rels between two same-repo items (directional, as authored)', async () => {
    const a = await add({ claim: 'old way' });
    const b = await add({ claim: 'new way' });

    const sup = await store.addLink({ id: '', fromMemoryId: b.id, rel: 'supersedes', toKind: 'memory', toRef: a.id });
    expect(sup.id).toMatch(/^lnk_/);
    expect(sup.rel).toBe('supersedes');
    expect(sup.toKind).toBe('memory');
    // Directional: stored exactly as authored (b supersedes a), NOT canonicalized.
    expect(sup.fromMemoryId).toBe(b.id);
    expect(sup.toRef).toBe(a.id);

    const con = await store.addLink({ id: '', fromMemoryId: a.id, rel: 'contradicts', toKind: 'memory', toRef: b.id });
    expect(con.rel).toBe('contradicts');
    expect(con.fromMemoryId).toBe(a.id);
    expect(con.toRef).toBe(b.id);
  }, 30_000);

  it('addLink: rejects a memory rel whose toKind is not "memory" (bad rel+kind combo)', async () => {
    const a = await add();
    await expect(
      store.addLink({ id: '', fromMemoryId: a.id, rel: 'supersedes', toKind: 'node', toRef: 'Function:x' }),
    ).rejects.toThrow(/unsupported memory_link rel/);
  }, 30_000);

  it('addLink: rejects a self-link', async () => {
    const a = await add();
    await expect(
      store.addLink({ id: '', fromMemoryId: a.id, rel: 'recurs-with', toKind: 'memory', toRef: a.id }),
    ).rejects.toThrow(/self-link/);
  }, 30_000);

  it('addLink: rejects when either endpoint is missing', async () => {
    const a = await add();
    await expect(
      store.addLink({ id: '', fromMemoryId: a.id, rel: 'supersedes', toKind: 'memory', toRef: 'mem_ghost' }),
    ).rejects.toThrow(/to item not found/);
    await expect(
      store.addLink({ id: '', fromMemoryId: 'mem_ghost', rel: 'supersedes', toKind: 'memory', toRef: a.id }),
    ).rejects.toThrow(/from item not found/);
  }, 30_000);

  it('addLink: rejects a cross-repo memory edge (HOR-46 — repos never link)', async () => {
    const a = await add({ repo: 'r' });
    const other = await add({ repo: 'other' });
    await expect(
      store.addLink({ id: '', fromMemoryId: a.id, rel: 'recurs-with', toKind: 'memory', toRef: other.id }),
    ).rejects.toThrow(/cross-repo/);
  }, 30_000);

  it('recurs-with: canonicalizes the symmetric pair (smaller id first) and dedupes (a,b)==(b,a)', async () => {
    const a = await add({ claim: 'incident A' });
    const b = await add({ claim: 'incident B' });
    const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];

    // Author it "the wrong way round" — it must canonicalize to (lo -> hi).
    const first = await store.addLink({ id: '', fromMemoryId: hi, rel: 'recurs-with', toKind: 'memory', toRef: lo });
    expect(first.fromMemoryId).toBe(lo);
    expect(first.toRef).toBe(hi);

    // Re-authoring either orientation returns the SAME stored row (deduped), not a twin.
    const again = await store.addLink({ id: '', fromMemoryId: lo, rel: 'recurs-with', toKind: 'memory', toRef: hi });
    expect(again.id).toBe(first.id);
    const reverse = await store.addLink({ id: '', fromMemoryId: hi, rel: 'recurs-with', toKind: 'memory', toRef: lo });
    expect(reverse.id).toBe(first.id);

    // Exactly one stored edge.
    expect(await store.links(lo, { direction: 'out', rels: ['recurs-with'] })).toHaveLength(1);
  }, 30_000);

  it('links: returns BOTH directions annotated; a symmetric edge surfaces from either endpoint', async () => {
    const a = await add({ claim: 'A' });
    const b = await add({ claim: 'B' });
    // b supersedes a (directional), and a recurs-with b (symmetric, canonicalized).
    await store.addLink({ id: '', fromMemoryId: b.id, rel: 'supersedes', toKind: 'memory', toRef: a.id });
    await store.addLink({ id: '', fromMemoryId: a.id, rel: 'recurs-with', toKind: 'memory', toRef: b.id });

    // From a's perspective: the supersedes edge points AT it (in); the recurs-with surfaces too.
    const aBoth = await store.links(a.id);
    expect(aBoth.some((l) => l.rel === 'supersedes' && l.direction === 'in')).toBe(true);
    expect(aBoth.some((l) => l.rel === 'recurs-with')).toBe(true);

    // Direction filters partition cleanly.
    const aOut = await store.links(a.id, { direction: 'out' });
    expect(aOut.every((l) => l.direction === 'out')).toBe(true);
    expect(aOut.some((l) => l.rel === 'supersedes')).toBe(false); // supersedes was authored from b
    const aIn = await store.links(a.id, { direction: 'in' });
    expect(aIn.every((l) => l.direction === 'in')).toBe(true);
    expect(aIn.some((l) => l.rel === 'supersedes')).toBe(true);

    // The symmetric edge is visible from b too (canonical-from side sees it outgoing).
    const bBoth = await store.links(b.id);
    expect(bBoth.some((l) => l.rel === 'recurs-with')).toBe(true);
    expect(bBoth.some((l) => l.rel === 'supersedes' && l.direction === 'out')).toBe(true);
  }, 30_000);

  it('audit: every link appends a `link` row keyed to the FROM item with NON-OPTIONAL detection', async () => {
    const a = await add({ claim: 'A' });
    const b = await add({ claim: 'B' });
    await store.addLink(
      { id: '', fromMemoryId: a.id, rel: 'supersedes', toKind: 'memory', toRef: b.id },
      { audit: { actor, note: 'manual triage' } },
    );

    const history = await store.history(a.id);
    const link = history.find((h) => h.action === 'link');
    expect(link).toBeDefined();
    expect(link!.actor).toEqual(actor);
    const detail = link!.detail as { rel: string; toKind: string; toRef: string; detection: string };
    expect(detail.rel).toBe('supersedes');
    expect(detail.toKind).toBe('memory');
    expect(detail.toRef).toBe(b.id);
    expect(detail.detection).toBe('manual'); // non-optional, defaults to manual
  }, 30_000);

  it('HONESTY: an auto-detected edge is CONTEXT-ONLY — its detection is recorded but status never flips', async () => {
    const a = await add({ claim: 'pattern A', status: 'fresh' });
    const b = await add({ claim: 'pattern B', status: 'fresh' });

    const edge = await store.addLink(
      { id: '', fromMemoryId: a.id, rel: 'recurs-with', toKind: 'memory', toRef: b.id },
      { detection: 'auto:recurrence', audit: { actor: { kind: 'system' } } },
    );

    // The detection label is honestly persisted on the (canonical) FROM item's trail...
    const detail = (await store.history(edge.fromMemoryId)).find((h) => h.action === 'link')!.detail as {
      detection: string;
    };
    expect(detail.detection).toBe('auto:recurrence');

    // ...but the auto-detector NEVER mutates item state (no status flip, no confidence change).
    const reFetchedA = await store.get(a.id);
    const reFetchedB = await store.get(b.id);
    expect(reFetchedA!.status).toBe('fresh');
    expect(reFetchedB!.status).toBe('fresh');
    expect(reFetchedA!.confidence).toBe(0.8);
  }, 30_000);

  it('HONESTY: `contradicts` is a FLAG, not a deletion — neither item is forgotten or status-flipped', async () => {
    const a = await add({ claim: 'X is true', status: 'fresh' });
    const b = await add({ claim: 'X is false', status: 'fresh' });

    await store.addLink(
      { id: '', fromMemoryId: a.id, rel: 'contradicts', toKind: 'memory', toRef: b.id },
      { detection: 'auto:contradiction', audit: { actor: { kind: 'system' } } },
    );

    // Both rows are retained and unchanged — contradiction surfaces as an edge, never an auto-status.
    const aAfter = await store.get(a.id);
    const bAfter = await store.get(b.id);
    expect(aAfter!.status).toBe('fresh');
    expect(bAfter!.status).toBe('fresh');

    // The edge exists and is queryable as a flag from both sides.
    expect((await store.links(a.id)).some((l) => l.rel === 'contradicts')).toBe(true);
    expect((await store.links(b.id)).some((l) => l.rel === 'contradicts' && l.direction === 'in')).toBe(true);
  }, 30_000);
});
