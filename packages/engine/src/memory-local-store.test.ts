/**
 * createLocalMemoryStore — drizzle/Postgres impl of the MemoryStore seam (M1, spec §6).
 *
 * Exercised against the embedded pglite db (as the @horus/db-backed tests do) so the bundled
 * EMBEDDED_MIGRATIONS supplying memory_item/_link/_audit are proven end-to-end. Covers CRUD, the
 * status lifecycle + audit trail, soft-forget reversibility, link create/traverse, and the §7
 * PII/secret + confirmed-outcome privacy gates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDb, type HorusDb, type NewMemoryItem } from '@horus/db';
import { createLocalMemoryStore, detectClaimSecret, MemorySecretError } from './memory.js';
import type { MemoryStore, AuditCtx } from './memory-store.js';

const actor = { kind: 'user' as const, id: 'u1', name: 'Alice' };

describe('createLocalMemoryStore (embedded pglite)', () => {
  let dir: string;
  let close: () => Promise<void>;
  let db: HorusDb;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'horus-mem-store-'));
    const handle = await createLocalDb({ path: join(dir, 'horus.db') });
    db = handle.db;
    close = () => handle.sql.end();
    store = createLocalMemoryStore(db);
  });

  // Pass a blank id so the store mints one (exercising genId); keeps call sites terse.
  const add = (item: Omit<NewMemoryItem, 'id'>, auditCtx: AuditCtx) =>
    store.add({ ...item, id: '' }, auditCtx);

  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('add: inserts, returns the row, defaults status/visibility, appends an `add` audit row', async () => {
    const item = await add(
      { kind: 'decision', claim: 'consumers must ack before processing', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' },
      { actor, note: 'created' },
    );
    expect(item.id).toMatch(/^mem_/);
    expect(item.status).toBe('fresh'); // default
    expect(item.visibility).toBe('private'); // default
    expect(item.evidence).toEqual([]); // jsonb default

    const back = await store.get(item.id);
    expect(back?.claim).toBe('consumers must ack before processing');

    const history = await store.history(item.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.action).toBe('add');
    expect(history[0]!.toStatus).toBe('fresh');
    expect(history[0]!.actor).toEqual(actor);
    expect(history[0]!.note).toBe('created');
  }, 30_000);

  it('get: returns null for a missing id', async () => {
    expect(await store.get('mem_nope')).toBeNull();
  }, 30_000);

  it('query: filters by scope/status/visibility and is repo fail-closed (HOR-46)', async () => {
    const a = await add(
      { kind: 'code-fact', claim: 'alpha symbol fact', scope: 'symbol:Function:src/a.ts:f', source: 'derived', confidence: 0.5, repo: 'r' },
      { actor },
    );
    await add(
      { kind: 'decision', claim: 'repo wide decision', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' },
      { actor },
    );
    // Another repo — must never surface for repo 'r'.
    await add(
      { kind: 'decision', claim: 'other repo decision', scope: 'repo', source: 'human', confidence: 0.9, repo: 'other' },
      { actor },
    );

    expect((await store.query({ repo: 'r' }))).toHaveLength(2);
    expect((await store.query({ repo: 'r', scope: 'repo' }))).toHaveLength(1);
    expect((await store.query({ repo: 'other' })).map((i) => i.claim)).toEqual(['other repo decision']);

    // fail-closed: a blank repo identity sees nothing.
    expect(await store.query({ repo: '   ' })).toEqual([]);

    // status filter
    await store.setStatus(a.id, 'forgotten', { actor });
    expect((await store.query({ repo: 'r', status: ['fresh'] }))).toHaveLength(1);
    expect((await store.query({ repo: 'r', status: ['fresh', 'forgotten'] }))).toHaveLength(2);
  }, 30_000);

  it('setStatus + soft-forget: status flips, the row is retained and reversible, audit records from/to', async () => {
    const item = await add(
      { kind: 'pitfall', claim: 'beware retry storm', scope: 'repo', source: 'human', confidence: 0.7, repo: 'r' },
      { actor },
    );

    await store.setStatus(item.id, 'forgotten', { actor, note: 'no longer relevant' });
    const forgotten = await store.get(item.id);
    expect(forgotten).not.toBeNull(); // SOFT: row retained
    expect(forgotten!.status).toBe('forgotten');

    // reversible
    await store.setStatus(item.id, 'fresh', { actor });
    expect((await store.get(item.id))!.status).toBe('fresh');

    const history = await store.history(item.id);
    // most-recent-first: confirm(fresh) → forget → add
    expect(history.map((h) => h.action)).toEqual(['confirm', 'forget', 'add']);
    const forget = history.find((h) => h.action === 'forget')!;
    expect(forget.fromStatus).toBe('fresh');
    expect(forget.toStatus).toBe('forgotten');
    expect(forget.note).toBe('no longer relevant');
  }, 30_000);

  it('setStatus/verify/setVisibility throw for a missing id', async () => {
    await expect(store.setStatus('mem_x', 'pinned', { actor })).rejects.toThrow(/not found/);
    await expect(store.verify('mem_x', { lastVerifiedHash: 'h' }, { actor })).rejects.toThrow(/not found/);
    await expect(store.setVisibility('mem_x', 'team', { actor })).rejects.toThrow(/not found/);
  }, 30_000);

  it('verify: refreshes the staleness snapshot and resets possibly-stale -> fresh', async () => {
    const item = await add(
      { kind: 'code-fact', claim: 'f returns a promise', scope: 'symbol:Function:src/a.ts:f', source: 'derived', confidence: 0.6, repo: 'r' },
      { actor },
    );
    await store.setStatus(item.id, 'possibly-stale', { actor });

    await store.verify(item.id, { lastVerifiedHash: 'sha256:abc' }, { actor, note: 'rechecked' });
    const verified = await store.get(item.id);
    expect(verified!.status).toBe('fresh'); // possibly-stale -> fresh
    expect(verified!.lastVerifiedHash).toBe('sha256:abc');
    expect(verified!.lastVerifiedAt).toBeInstanceOf(Date);

    const verifyAudit = (await store.history(item.id)).find((h) => h.action === 'verify')!;
    expect(verifyAudit.fromStatus).toBe('possibly-stale');
    expect(verifyAudit.toStatus).toBe('fresh');
  }, 30_000);

  it('verify: leaves a pinned item pinned (does not resurrect non-stale statuses)', async () => {
    const item = await add(
      { kind: 'decision', claim: 'keep this pinned', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' },
      { actor },
    );
    await store.setStatus(item.id, 'pinned', { actor });
    await store.verify(item.id, { lastVerifiedHash: 'h2' }, { actor });
    expect((await store.get(item.id))!.status).toBe('pinned');
  }, 30_000);

  it('setVisibility: updates visibility and audits the change', async () => {
    const item = await add(
      { kind: 'decision', claim: 'shareable decision', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' },
      { actor },
    );
    await store.setVisibility(item.id, 'team', { actor });
    expect((await store.get(item.id))!.visibility).toBe('team');
    expect((await store.history(item.id)).some((h) => h.action === 'set-visibility')).toBe(true);
  }, 30_000);

  it('privacy gate: add rejects an obvious secret in the claim (spec §7)', async () => {
    await expect(
      add(
        { kind: 'pitfall', claim: 'the api_key=sk_live_supersecretvalue must be rotated', scope: 'repo', source: 'human', confidence: 0.5, repo: 'r' },
        { actor },
      ),
    ).rejects.toBeInstanceOf(MemorySecretError);

    // nothing persisted
    expect(await store.query({ repo: 'r' })).toEqual([]);
  }, 30_000);

  it('privacy gate: confirmed-outcome is forced to private even if team is requested', async () => {
    const item = await add(
      { kind: 'confirmed-outcome', claim: 'root cause was a missing index', scope: 'repo', source: 'confirmed-outcome', confidence: 0.9, repo: 'r', visibility: 'team' },
      { actor },
    );
    expect(item.visibility).toBe('private'); // never auto-team
  }, 30_000);

  it('detectClaimSecret: flags credentials, passes clean prose', () => {
    expect(detectClaimSecret('plain decision about queue acking')).toBeNull();
    expect(detectClaimSecret('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toBe('private-key');
    expect(detectClaimSecret('AKIAABCDEFGHIJKLMNOP')).toBe('aws-key');
    expect(detectClaimSecret('Authorization: Bearer abc.def.ghi')).toBe('auth-header');
  });

  it('links: creates, restricts to M1 rels, and traverses with a rel filter', async () => {
    const item = await add(
      { kind: 'code-fact', claim: 'consume acks the message', scope: 'symbol:Function:src/queue.ts:consume', source: 'derived', confidence: 0.6, repo: 'r' },
      { actor },
    );
    await store.addLink({ id: '', fromMemoryId: item.id, rel: 'about-symbol', toKind: 'node', toRef: 'Function:src/queue.ts:consume', toFilePath: 'src/queue.ts' });
    await store.addLink({ id: '', fromMemoryId: item.id, rel: 'has-evidence', toKind: 'evidence', toRef: 'ev_123' });

    const all = await store.links(item.id);
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toMatch(/^lnk_/);

    const onlySymbol = await store.links(item.id, { rels: ['about-symbol'] });
    expect(onlySymbol).toHaveLength(1);
    expect(onlySymbol[0]!.toFilePath).toBe('src/queue.ts');

    // A memory rel with the wrong toKind is rejected at the store boundary (memory rels require
    // toKind:'memory'). The memory→memory graph itself is covered in memory-link-graph.test.ts.
    await expect(
      store.addLink({ id: '', fromMemoryId: item.id, rel: 'supersedes', toKind: 'node', toRef: 'mem_other' }),
    ).rejects.toThrow(/unsupported memory_link rel/);
  }, 30_000);
});
