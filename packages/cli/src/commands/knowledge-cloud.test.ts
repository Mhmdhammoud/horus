import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../lib/cloud/session.js', () => ({
  authedClient: vi.fn(),
  repoRootOrCwd: (c?: string) => c ?? process.cwd(),
}));
vi.mock('../lib/cloud/context-store.js', () => ({
  readCloudConfig: vi.fn(),
  isCloudActive: vi.fn(),
}));

import { authedClient } from '../lib/cloud/session.js';
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';
import { CloudError } from '../lib/cloud/api.js';
import { createJsonKnowledgeStore, KnowledgeSnapshotSchema, KNOWLEDGE_SCHEMA_VERSION } from '@horus/knowledge';
import { runKnowledgePush, runKnowledgePull, runKnowledgeCloudStatus } from './knowledge-cloud.js';

const mAuthed = vi.mocked(authedClient);
const mReadCfg = vi.mocked(readCloudConfig);
const mIsActive = vi.mocked(isCloudActive);

const dirs: string[] = [];
let localHash: string;

function snapshot() {
  return KnowledgeSnapshotSchema.parse({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: '2026-06-19T15:00:00.000Z',
    project: 'demo',
    enums: [{ id: 'enum:Role', provenance: { sourceType: 'parsed' }, name: 'Role', values: ['ADMIN'] }],
  });
}
function indexedRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-knsync-'));
  dirs.push(d);
  const manifest = createJsonKnowledgeStore(d).write(snapshot(), {
    generator: { tool: 'horus-cli' },
    git: { sha: 'a'.repeat(40), branch: 'work' },
  });
  localHash = manifest.files.find((f) => f.name === 'knowledge-base.json')!.contentHash!;
  return d;
}
function emptyRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-knempty-'));
  dirs.push(d);
  return d;
}

function fakeClient(over: Record<string, unknown> = {}) {
  return { getLatestKnowledgeSnapshot: vi.fn(), pushKnowledgeSnapshot: vi.fn(), ...over } as never;
}
function loginAs(client: unknown) {
  mAuthed.mockReturnValue({ client, auth: { apiBaseUrl: 'x', token: 't', account: { userId: 'u', email: 'e' } } } as never);
}
function cloudLinked(projectId = 'p1') {
  mReadCfg.mockReturnValue({ context: 'cloud', project: { id: projectId, slug: 'horus' } } as never);
  mIsActive.mockReturnValue(true as never);
}
const notFound = () => new CloudError(404, 'not_found', 'no snapshot');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  mAuthed.mockReset();
  mReadCfg.mockReset();
  mIsActive.mockReset();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('runKnowledgePush — gating', () => {
  it('fails with no local index', async () => {
    expect(await runKnowledgePush({ cwd: emptyRoot() })).toBe(1);
  });
  it('fails (gated) when not logged in', async () => {
    mAuthed.mockReturnValue(null);
    expect(await runKnowledgePush({ cwd: indexedRoot() })).toBe(1);
  });
  it('fails (gated) when the repo is not cloud-linked', async () => {
    loginAs(fakeClient());
    mReadCfg.mockReturnValue(null as never);
    mIsActive.mockReturnValue(false as never);
    expect(await runKnowledgePush({ cwd: indexedRoot() })).toBe(1);
  });
});

describe('runKnowledgePush — dedup + upload', () => {
  it('skips when the cloud already has this content hash', async () => {
    const root = indexedRoot();
    const client = fakeClient({
      getLatestKnowledgeSnapshot: vi.fn().mockResolvedValue({ contentHash: localHash }),
    });
    loginAs(client);
    cloudLinked();
    expect(await runKnowledgePush({ cwd: root })).toBe(0);
    expect((client as { pushKnowledgeSnapshot: ReturnType<typeof vi.fn> }).pushKnowledgeSnapshot).not.toHaveBeenCalled();
  });

  it('uploads with the content hash when the cloud has no snapshot yet', async () => {
    const root = indexedRoot();
    const push = vi.fn().mockResolvedValue({ contentHash: localHash });
    const client = fakeClient({
      getLatestKnowledgeSnapshot: vi.fn().mockRejectedValue(notFound()),
      pushKnowledgeSnapshot: push,
    });
    loginAs(client);
    cloudLinked('proj-1');
    expect(await runKnowledgePush({ cwd: root })).toBe(0);
    expect(push).toHaveBeenCalledTimes(1);
    const [projectId, body] = push.mock.calls[0] as [string, Record<string, unknown>];
    expect(projectId).toBe('proj-1');
    expect(body.contentHash).toBe(localHash);
    expect(body.idempotencyKey).toBe(localHash);
    expect(body.gitSha).toBe('a'.repeat(40));
    expect(body.snapshot).toBeTruthy();
  });

  it('dry-run does not upload', async () => {
    const root = indexedRoot();
    const push = vi.fn();
    const client = fakeClient({
      getLatestKnowledgeSnapshot: vi.fn().mockRejectedValue(notFound()),
      pushKnowledgeSnapshot: push,
    });
    loginAs(client);
    cloudLinked();
    expect(await runKnowledgePush({ cwd: root, dryRun: true })).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('runKnowledgePull', () => {
  it('reports cleanly when there is no cloud snapshot', async () => {
    const client = fakeClient({ getLatestKnowledgeSnapshot: vi.fn().mockRejectedValue(notFound()) });
    loginAs(client);
    cloudLinked();
    expect(await runKnowledgePull({ cwd: emptyRoot() })).toBe(0);
  });

  it('writes the cloud snapshot into the local index', async () => {
    const root = emptyRoot();
    const cloudSnap = KnowledgeSnapshotSchema.parse({
      schemaVersion: 1,
      generatedAt: '2026-06-19T16:00:00.000Z',
      project: 'demo',
      operations: [{ id: 'operation:doThing', provenance: { sourceType: 'imported' }, name: 'doThing', kind: 'mutation' }],
    });
    const client = fakeClient({
      getLatestKnowledgeSnapshot: vi.fn().mockResolvedValue({
        contentHash: 'cloudhash', gitSha: 'b'.repeat(40), branch: 'main', snapshot: cloudSnap,
      }),
    });
    loginAs(client);
    cloudLinked();
    expect(await runKnowledgePull({ cwd: root })).toBe(0);
    const local = createJsonKnowledgeStore(root).readSnapshot();
    expect(local?.operations[0]?.name).toBe('doThing');
  });
});

describe('runKnowledgeCloudStatus', () => {
  it('is a no-op message when not logged in (offline-safe)', async () => {
    mAuthed.mockReturnValue(null);
    expect(await runKnowledgeCloudStatus({ cwd: indexedRoot() })).toBe(0);
  });
});
