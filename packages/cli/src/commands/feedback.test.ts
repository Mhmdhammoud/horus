/**
 * HOR-390 — Tests for the eval-store persistence side of `horus feedback`.
 *
 * The telemetry behavior of `runFeedback` is covered in lib/telemetry/feedback.test.ts; here we
 * pin the ADDED behavior: `--resolved` ALSO persists a durable outcome label (source=feedback) into
 * the converged eval store, scoped to the resolved project, and that this is BEST-EFFORT — a DB or
 * config failure never breaks the telemetry-only feedback contract (still returns 0).
 *
 * @horus/core (loadConfig/resolveEnvironment) and the DB-touching @horus/db calls are mocked;
 * isOutcomeResolved stays real so verdict validation is exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveEnvironment: vi.fn(),
}));
const db = vi.hoisted(() => ({
  openDb: vi.fn(),
  recordOutcomeLabel: vi.fn(),
}));
const sqlEnd = vi.fn(async () => {});

vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return { ...actual, loadConfig: core.loadConfig, resolveEnvironment: core.resolveEnvironment };
});
vi.mock('@horus/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/db')>();
  return { ...actual, openDb: db.openDb, recordOutcomeLabel: db.recordOutcomeLabel };
});

import { runFeedback } from './feedback.js';

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

let home: string;
let origIn: unknown;
let origOut: unknown;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'horus-fb-cmd-'));
  process.env.HORUS_HOME = home;
  origIn = (process.stdin as unknown as { isTTY: unknown }).isTTY;
  origOut = (process.stdout as unknown as { isTTY: unknown }).isTTY;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  core.loadConfig.mockResolvedValue({ database: { url: 'postgresql://x' } });
  core.resolveEnvironment.mockReturnValue({ project: 'my-api' });
  db.openDb.mockResolvedValue({ db: { fake: true }, sql: { end: sqlEnd } });
  db.recordOutcomeLabel.mockResolvedValue({ id: 'ol_1' });
  setTTY(false); // agents run non-interactively
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', { value: origIn, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: origOut, configurable: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.HORUS_HOME;
});

describe('runFeedback — eval-store persistence (HOR-390)', () => {
  it('persists a project-scoped outcome label (source=feedback) from --resolved', async () => {
    const code = await runFeedback('inv-9', { resolved: 'partly', manualEstimateMin: '30' });
    expect(code).toBe(0);
    expect(db.recordOutcomeLabel).toHaveBeenCalledTimes(1);
    const [, label] = db.recordOutcomeLabel.mock.calls[0]!;
    expect(label).toMatchObject({
      investigationId: 'inv-9',
      resolved: 'partly',
      source: 'feedback',
      project: 'my-api',
      payload: { manualEstimateMinutes: 30 },
    });
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('threads --repo into project resolution for the label', async () => {
    core.resolveEnvironment.mockReturnValueOnce({ project: 'other-svc' });
    const code = await runFeedback('inv-9', { resolved: 'yes', repo: 'other-svc' });
    expect(code).toBe(0);
    expect(core.resolveEnvironment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ project: 'other-svc' }),
    );
    const [, label] = db.recordOutcomeLabel.mock.calls[0]!;
    expect(label.project).toBe('other-svc');
  });

  it('does not persist (or open the DB) on an invalid verdict', async () => {
    const code = await runFeedback('inv-9', { resolved: 'maybe' });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(db.recordOutcomeLabel).not.toHaveBeenCalled();
  });

  it('is best-effort: a DB failure never breaks feedback (still returns 0)', async () => {
    db.openDb.mockRejectedValueOnce(new Error('db down'));
    const code = await runFeedback('inv-9', { resolved: 'yes' });
    expect(code).toBe(0);
    expect(db.recordOutcomeLabel).not.toHaveBeenCalled();
  });

  it('stores a null project when it cannot be resolved (write does not fail closed)', async () => {
    core.resolveEnvironment.mockImplementationOnce(() => {
      throw new Error('unresolvable');
    });
    const code = await runFeedback('inv-9', { resolved: 'no' });
    expect(code).toBe(0);
    const [, label] = db.recordOutcomeLabel.mock.calls[0]!;
    expect(label.project).toBeNull();
  });
});
