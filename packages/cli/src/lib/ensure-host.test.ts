/**
 * HOR-319 (Bug 2) — unit tests for the source-host self-heal helper.
 *
 * The host-lifecycle primitives (@horus/connectors) are mocked so we can drive each
 * branch of ensureSourceHost without spawning a real `horus-source` process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted so the mock object exists before the hoisted vi.mock factory runs.
const connectors = vi.hoisted(() => ({
  isHostHealthy: vi.fn(),
  sourceAvailable: vi.fn(),
  assertSourceVersionPinned: vi.fn(),
  isAnalyzed: vi.fn(),
  startHost: vi.fn(),
  waitForHost: vi.fn(),
  removeSpawnedHostRecord: vi.fn(),
}));

vi.mock('@horus/connectors', () => connectors);

import {
  parseHostPort,
  ensureHostReasonHint,
  ensureSourceHost,
} from './ensure-host.js';

const URL_8420 = 'http://127.0.0.1:8420';

beforeEach(() => {
  for (const fn of Object.values(connectors)) fn.mockReset();
  // Sensible defaults: backend present, version pinned, and repo analyzed unless a test
  // says otherwise.
  connectors.sourceAvailable.mockResolvedValue(true);
  connectors.assertSourceVersionPinned.mockResolvedValue(undefined);
  connectors.isAnalyzed.mockReturnValue(true);
});

afterEach(() => vi.restoreAllMocks());

describe('parseHostPort', () => {
  it('extracts the port', () => {
    expect(parseHostPort(URL_8420)).toBe(8420);
    expect(parseHostPort('http://127.0.0.1:9001')).toBe(9001);
  });
  it('returns null when there is no port or the URL is invalid', () => {
    expect(parseHostPort('http://example.com')).toBeNull();
    expect(parseHostPort('not a url')).toBeNull();
  });
});

describe('ensureHostReasonHint', () => {
  it('maps each reason to an actionable hint', () => {
    expect(ensureHostReasonHint('source-unavailable')).toMatch(/pip install horus-source/);
    expect(ensureHostReasonHint('version-mismatch')).toMatch(/pinned/);
    expect(ensureHostReasonHint('not-analyzed')).toMatch(/horus index/);
    expect(ensureHostReasonHint('bad-url')).toMatch(/valid URL/);
    expect(ensureHostReasonHint('unhealthy')).toMatch(/horus index/);
    expect(ensureHostReasonHint(undefined)).toMatch(/horus index/);
  });
});

describe('ensureSourceHost', () => {
  it('returns ok without restarting when the host is already healthy', async () => {
    connectors.isHostHealthy.mockResolvedValue(true);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: true, hostUrl: URL_8420 });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('reports source-unavailable when horus-source is not installed', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.sourceAvailable.mockResolvedValue(false);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: false, reason: 'source-unavailable' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('reports version-mismatch when the installed backend is drifted', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.assertSourceVersionPinned.mockRejectedValue(
      new Error('horus-source 1.4.0 is installed but Horus is pinned to 1.0.7'),
    );
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: false, reason: 'version-mismatch' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('reports not-analyzed for a repo that has never been indexed', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.isAnalyzed.mockReturnValue(false);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: false, reason: 'not-analyzed' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('reports bad-url when the configured host URL has no port', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    const res = await ensureSourceHost('/repo', 'http://example.com');
    expect(res).toEqual({ ok: false, reason: 'bad-url' });
    expect(connectors.startHost).not.toHaveBeenCalled();
  });

  it('restarts at the configured port and returns ok when it becomes healthy', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.waitForHost.mockResolvedValue(true);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: true, hostUrl: URL_8420 });
    expect(connectors.startHost).toHaveBeenCalledWith('/repo', 8420);
    expect(connectors.removeSpawnedHostRecord).not.toHaveBeenCalled();
  });

  it('cleans up the ownership record when the restart never goes healthy', async () => {
    connectors.isHostHealthy.mockResolvedValue(false);
    connectors.waitForHost.mockResolvedValue(false);
    const res = await ensureSourceHost('/repo', URL_8420);
    expect(res).toEqual({ ok: false, reason: 'unhealthy' });
    expect(connectors.startHost).toHaveBeenCalledWith('/repo', 8420);
    expect(connectors.removeSpawnedHostRecord).toHaveBeenCalledWith('/repo');
  });
});
