import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runSetup } from './setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureOutput(
  fn: (write: (line: string) => void) => Promise<number>,
): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((code) => ({ lines, code }));
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@horus/connectors', () => ({
  getSourceVersion: vi.fn(),
  SourceHttpClient: vi.fn(),
}));

vi.mock('@horus/db', () => ({
  checkDatabase: vi.fn(),
}));

vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return {
    ...actual,
    loadConfig: vi.fn(),
    PINNED_SOURCE_VERSION: '1.0.1',
  };
});

import { getSourceVersion, SourceHttpClient } from '@horus/connectors';
import { checkDatabase } from '@horus/db';
import { loadConfig } from '@horus/core';

const mockGetSourceVersion = vi.mocked(getSourceVersion);
const mockCheckDatabase = vi.mocked(checkDatabase);
const mockLoadConfig = vi.mocked(loadConfig);
const MockSourceHttpClient = vi.mocked(SourceHttpClient as unknown as new (...args: unknown[]) => {
  health: () => Promise<{ ok: boolean; status: number }>;
  nodeCount: () => Promise<number>;
});

// ---------------------------------------------------------------------------
// Shared fixture for a passing state
// ---------------------------------------------------------------------------

const PASSING_DB = { reachable: true, schemaReady: true, schemaDetail: '8 tables' } as Awaited<ReturnType<typeof checkDatabase>>;

const REPO_AXON_CONFIG = {
  name: 'my-repo',
  path: '/repos/my-repo',
  source: { hostUrl: 'http://127.0.0.1:8420' },
};

const MINIMAL_CONFIG = {
  projects: [{ name: 'proj', repositories: [REPO_AXON_CONFIG], environments: [] }],
  database: { url: 'postgresql://horus:horus@localhost:5433/horus' },
  axon: { pinnedVersion: '1.0.1' },
  models: { reasoning: 'claude-opus-4-8', extraction: 'claude-haiku-4-5' },
} as unknown as Awaited<ReturnType<typeof loadConfig>>;

function makeSourceClient(health: { ok: boolean }, nodeCount = 42) {
  return {
    health: vi.fn().mockResolvedValue(health),
    nodeCount: vi.fn().mockResolvedValue(nodeCount),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path mocks
  mockGetSourceVersion.mockResolvedValue('1.0.1');
  mockCheckDatabase.mockResolvedValue(PASSING_DB);
  mockLoadConfig.mockResolvedValue(MINIMAL_CONFIG);
  MockSourceHttpClient.mockImplementation(
    () => makeSourceClient({ ok: true }) as ReturnType<typeof makeSourceClient>,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// All-green path
// ---------------------------------------------------------------------------

describe('runSetup — all prerequisites met', () => {
  it('exits 0', async () => {
    const { code } = await captureOutput((write) => runSetup({ write }));
    expect(code).toBe(0);
  });

  it('output contains green markers for backend, postgres, and repo', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    const output = lines.join('\n');
    expect(output).toContain('source-intelligence backend');
    expect(output).toContain('Postgres reachable');
    expect(output).toContain('nodes indexed');
  });

  it('shows "Ready." when everything passes', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    expect(lines.join('\n')).toContain('Ready.');
  });
});

// ---------------------------------------------------------------------------
// Axon binary missing
// ---------------------------------------------------------------------------

describe('runSetup — Axon binary not found', () => {
  beforeEach(() => {
    mockGetSourceVersion.mockResolvedValue(null);
  });

  it('exits 1', async () => {
    const { code } = await captureOutput((write) => runSetup({ write }));
    expect(code).toBe(1);
  });

  it('output explains how to install axoniq', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    const output = lines.join('\n');
    expect(output).toContain('uv tool install axoniq');
    expect(output).toContain('1.0.1');
  });
});

// ---------------------------------------------------------------------------
// Axon binary version mismatch
// ---------------------------------------------------------------------------

describe('runSetup — Axon binary version mismatch', () => {
  beforeEach(() => {
    mockGetSourceVersion.mockResolvedValue('0.9.0');
  });

  it('exits 1', async () => {
    const { code } = await captureOutput((write) => runSetup({ write }));
    expect(code).toBe(1);
  });

  it('output mentions version mismatch and update command', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    const output = lines.join('\n');
    expect(output).toContain('version mismatch');
    expect(output).toContain('update it');
  });
});

// ---------------------------------------------------------------------------
// Postgres unreachable
// ---------------------------------------------------------------------------

describe('runSetup — Postgres unreachable', () => {
  beforeEach(() => {
    mockCheckDatabase.mockResolvedValue({
      reachable: false,
      schemaReady: false,
      schemaDetail: '',
    } as Awaited<ReturnType<typeof checkDatabase>>);
  });

  it('exits 1', async () => {
    const { code } = await captureOutput((write) => runSetup({ write }));
    expect(code).toBe(1);
  });

  it('output includes docker run command', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    expect(lines.join('\n')).toContain('docker run');
  });
});

// ---------------------------------------------------------------------------
// Postgres reachable but schema not applied
// ---------------------------------------------------------------------------

describe('runSetup — Postgres reachable but schema missing', () => {
  beforeEach(() => {
    mockCheckDatabase.mockResolvedValue({
      reachable: true,
      schemaReady: false,
      schemaDetail: '0 tables',
    } as Awaited<ReturnType<typeof checkDatabase>>);
  });

  it('exits 1', async () => {
    const { code } = await captureOutput((write) => runSetup({ write }));
    expect(code).toBe(1);
  });

  it('output includes migration command', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    expect(lines.join('\n')).toContain('pnpm db migrate');
  });
});

// ---------------------------------------------------------------------------
// Axon host unreachable (running host, not binary)
// ---------------------------------------------------------------------------

describe('runSetup — Axon host unreachable', () => {
  beforeEach(() => {
    MockSourceHttpClient.mockImplementation(
      () => makeSourceClient({ ok: false }, 0) as ReturnType<typeof makeSourceClient>,
    );
  });

  it('exits 1', async () => {
    const { code } = await captureOutput((write) => runSetup({ write }));
    expect(code).toBe(1);
  });

  it('output includes repo name and horus index command', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    const output = lines.join('\n');
    expect(output).toContain('my-repo');
    expect(output).toContain('horus index');
    expect(output).toContain('8420');
  });

  it('output includes repo path for cd command', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    expect(lines.join('\n')).toContain('/repos/my-repo');
  });
});

// ---------------------------------------------------------------------------
// Axon host running but repo not indexed
// ---------------------------------------------------------------------------

describe('runSetup — Axon host running but repo not indexed', () => {
  beforeEach(() => {
    MockSourceHttpClient.mockImplementation(
      () => makeSourceClient({ ok: true }, 0) as ReturnType<typeof makeSourceClient>,
    );
  });

  it('exits 1', async () => {
    const { code } = await captureOutput((write) => runSetup({ write }));
    expect(code).toBe(1);
  });

  it('output includes horus index command', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    const output = lines.join('\n');
    expect(output).toContain('horus index');
    expect(output).toContain('/repos/my-repo');
  });
});

// ---------------------------------------------------------------------------
// No config — axon host checks are skipped gracefully
// ---------------------------------------------------------------------------

describe('runSetup — no config available', () => {
  beforeEach(() => {
    mockLoadConfig.mockRejectedValue(new Error('Config not found'));
  });

  it('does not throw', async () => {
    await expect(captureOutput((write) => runSetup({ write }))).resolves.not.toThrow();
  });

  it('still performs Axon binary and Postgres checks', async () => {
    const { lines } = await captureOutput((write) => runSetup({ write }));
    const output = lines.join('\n');
    expect(output).toContain('source-intelligence backend');
    expect(output).toContain('Postgres');
  });
});

// ---------------------------------------------------------------------------
// Repo without axon config — skipped silently
// ---------------------------------------------------------------------------

describe('runSetup — repo without axon config', () => {
  beforeEach(() => {
    mockLoadConfig.mockResolvedValue({
      ...MINIMAL_CONFIG,
      projects: [{
        name: 'proj',
        repositories: [{ name: 'no-axon', path: '/repos/no-axon' }],
        environments: [],
      }],
    } as unknown as Awaited<ReturnType<typeof loadConfig>>);
  });

  it('exits 0 (no axon checks to fail)', async () => {
    const { code } = await captureOutput((write) => runSetup({ write }));
    expect(code).toBe(0);
  });

  it('SourceHttpClient is never instantiated', async () => {
    await captureOutput((write) => runSetup({ write }));
    expect(MockSourceHttpClient).not.toHaveBeenCalled();
  });
});
