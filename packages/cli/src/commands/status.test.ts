/**
 * HOR-190 — Unit tests for MongoDB status reporting in `horus status`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStatus } from './status.js';
import type { StateProvider } from '@horus/connectors';

const dirs: string[] = [];

vi.mock('@horus/db', () => ({
  checkDatabase: vi.fn(async () => ({
    reachable: true,
    schemaReady: true,
    reachableDetail: 'connected',
    schemaDetail: 'schema ready',
  })),
}));

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-status-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  dirs.length = 0;
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.restoreAllMocks();
});

const DB = `{ url: "postgresql://horus:horus@localhost:5433/horus" }`;

function writeConfig(dir: string, mongo: string): string {
  const path = join(dir, 'horus.config.js');
  writeFileSync(
    path,
    `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { mongodb: ${mongo} },
    }],
  }],
};
`,
    'utf8',
  );
  return path;
}

function makeMongoProvider(opts: { ok: boolean; collections?: string[] }): StateProvider {
  return {
    id: 'mongodb',
    kind: 'state',
    async health() {
      return { ok: opts.ok, detail: opts.ok ? 'ok' : 'unreachable' };
    },
    async analyzeState() {
      throw new Error('not used');
    },
    toEvidence() {
      return [];
    },
    async listCollections() {
      return opts.collections ?? [];
    },
    async close() {},
  };
}

function mongoFactory(provider: StateProvider | null) {
  return () => provider;
}

async function captureStatus(
  configPath: string,
  factory: (() => StateProvider | null) | null,
): Promise<{ output: string; code: number }> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await runStatus(configPath, {
    project: 'my-api',
    env: 'production',
    _mongoFactory: factory ?? undefined,
  });
  const output = spy.mock.calls.map((c) => c.join(' ')).join('\n');
  spy.mockRestore();
  return { output, code };
}

// ---------------------------------------------------------------------------

describe('runStatus — MongoDB (HOR-190)', () => {
  it('shows "not configured" when no MongoDB connector is present', async () => {
    const dir = tempDir();
    const path = join(dir, 'horus.config.js');
    writeFileSync(
      path,
      `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`,
      'utf8',
    );
    const { output } = await captureStatus(path, mongoFactory(null));
    expect(output).toContain('MongoDB');
    expect(output).toContain('not configured');
  });

  it('shows a warning when MongoDB is configured without a URL', async () => {
    const dir = tempDir();
    const path = writeConfig(dir, '{ database: "my-api-prod" }');
    const { output } = await captureStatus(path, mongoFactory(null));
    expect(output).toContain('MongoDB');
    expect(output).toContain('but Mongo URL not set');
  });

  it('shows reachable with discovered count when auto-discovery is enabled', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://localhost:27017", database: "my-api-prod" }',
    );
    const provider = makeMongoProvider({
      ok: true,
      collections: ['users', 'orders', 'events'],
    });
    const { output } = await captureStatus(path, mongoFactory(provider));
    expect(output).toContain('MongoDB');
    expect(output).toContain('reachable');
    expect(output).toContain('db my-api-prod');
    expect(output).toContain('allowlist: all');
    expect(output).toContain('discovered: 3 collection(s)');
    expect(output).not.toContain('0 collection');
  });

  it('shows reachable with allowlist count when collections are explicit', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://localhost:27017", database: "my-api-prod", collections: ["users", "orders"] }',
    );
    const provider = makeMongoProvider({ ok: true, collections: ['users', 'orders'] });
    const { output } = await captureStatus(path, mongoFactory(provider));
    expect(output).toContain('MongoDB');
    expect(output).toContain('reachable');
    expect(output).toContain('allowlist: 2');
  });

  it('shows unreachable when MongoDB health fails', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://localhost:27017", database: "my-api-prod" }',
    );
    const provider = makeMongoProvider({ ok: false });
    const { output, code } = await captureStatus(path, mongoFactory(provider));
    expect(output).toContain('MongoDB');
    expect(output).toContain('unreachable');
    expect(output).toContain('db my-api-prod');
    expect(code).toBe(1);
  });

  it('does not leak MongoDB connection URL secrets', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://secret-user:secret-pass@mongo.internal:27017", database: "mydb" }',
    );
    const provider = makeMongoProvider({ ok: true, collections: [] });
    const { output } = await captureStatus(path, mongoFactory(provider));
    expect(output).not.toContain('secret-user');
    expect(output).not.toContain('secret-pass');
    expect(output).not.toContain('mongo.internal');
  });

  it('shows zero collections only when actually discovered as empty', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://localhost:27017", database: "my-api-prod" }',
    );
    const provider = makeMongoProvider({ ok: true, collections: [] });
    const { output } = await captureStatus(path, mongoFactory(provider));
    expect(output).toContain('allowlist: all');
    expect(output).toContain('discovered: 0 collection(s)');
  });
});
