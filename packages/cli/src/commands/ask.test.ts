/**
 * HOR-319 (Bug 1) — `horus ask` must accept the id `investigate` prints as its header.
 *
 * That id is the LOCAL investigation id; in a cloud-linked repo `ask` used to send it
 * straight to the cloud API, which only knows its own id, so it 404'd. These tests pin
 * the fix: resolve LOCAL first, fall back to cloud, and surface a clear not-found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => ({
  openDb: vi.fn(async () => ({ db: {}, sql: { end: vi.fn(async () => {}) } })),
  getInvestigation: vi.fn(),
}));
const cloud = vi.hoisted(() => ({
  isCloudActive: vi.fn(),
  fetchInvestigationReportFromCloud: vi.fn(),
  authedClient: vi.fn(() => ({ client: {} })),
  reportCloudError: vi.fn(() => 1),
}));
const engine = vi.hoisted(() => ({
  answerQuestion: vi.fn(() => ({ answer: 'because X' })),
  renderQAAnswer: vi.fn(() => 'ANSWER'),
  qaToJSON: vi.fn(() => '{}'),
  migrateReport: vi.fn((r: unknown) => r),
  refineInvestigation: vi.fn(),
  renderRefined: vi.fn(() => ''),
  refinedToJSON: vi.fn(() => '{}'),
}));

vi.mock('@horus/db', () => db);
vi.mock('../lib/db-url.js', () => ({ resolveDbUrl: vi.fn(async () => 'postgres://x') }));
vi.mock('@horus/engine', () => engine);
vi.mock('../lib/cloud/context-store.js', () => ({
  readCloudConfig: vi.fn(() => ({})),
  isCloudActive: cloud.isCloudActive,
}));
vi.mock('../lib/cloud/session.js', () => ({
  authedClient: cloud.authedClient,
  repoRootOrCwd: vi.fn(() => '/repo'),
}));
vi.mock('../lib/cloud/investigation-sync.js', () => ({
  fetchInvestigationReportFromCloud: cloud.fetchInvestigationReportFromCloud,
}));
vi.mock('../lib/cloud/api.js', () => ({
  CloudError: class CloudError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('./context.js', () => ({ reportCloudError: cloud.reportCloudError }));

import { runAsk } from './ask.js';
import { CloudError } from '../lib/cloud/api.js';

const REPORT = { id: 'local-id', input: { hint: 'x' } };

beforeEach(() => {
  for (const fn of [...Object.values(db), ...Object.values(cloud), ...Object.values(engine)]) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  db.openDb.mockResolvedValue({ db: {}, sql: { end: vi.fn(async () => {}) } });
  cloud.authedClient.mockReturnValue({ client: {} });
  cloud.reportCloudError.mockReturnValue(1);
  engine.answerQuestion.mockReturnValue({ answer: 'because X' });
  engine.renderQAAnswer.mockReturnValue('ANSWER');
  engine.migrateReport.mockImplementation((r: unknown) => r);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('runAsk — cloud-linked repo (HOR-319 Bug 1)', () => {
  it('answers from the LOCAL store when given the local id, without calling cloud', async () => {
    cloud.isCloudActive.mockReturnValue(true);
    db.getInvestigation.mockResolvedValue({ report: REPORT });

    const code = await runAsk('local-id', 'why?', {});

    expect(code).toBe(0);
    expect(db.getInvestigation).toHaveBeenCalledWith(expect.anything(), 'local-id');
    expect(cloud.fetchInvestigationReportFromCloud).not.toHaveBeenCalled();
    expect(engine.answerQuestion).toHaveBeenCalled();
  });

  it('falls back to cloud when the id is not in the local store', async () => {
    cloud.isCloudActive.mockReturnValue(true);
    db.getInvestigation.mockResolvedValue(null);
    cloud.fetchInvestigationReportFromCloud.mockResolvedValue(REPORT);

    const code = await runAsk('cloud-id', 'why?', {});

    expect(code).toBe(0);
    expect(cloud.fetchInvestigationReportFromCloud).toHaveBeenCalledTimes(1);
  });

  it('reports a clear not-found (not a raw cloud error) when cloud 404s after a local miss', async () => {
    cloud.isCloudActive.mockReturnValue(true);
    db.getInvestigation.mockResolvedValue(null);
    cloud.fetchInvestigationReportFromCloud.mockRejectedValue(
      new CloudError(404, 'not_found', 'Investigation not found'),
    );

    const code = await runAsk('bogus', 'why?', {});

    expect(code).toBe(1);
    expect(cloud.reportCloudError).not.toHaveBeenCalled();
  });
});

describe('runAsk — local mode', () => {
  it('answers from the local store', async () => {
    cloud.isCloudActive.mockReturnValue(false);
    db.getInvestigation.mockResolvedValue({ report: REPORT });

    const code = await runAsk('local-id', 'why?', {});

    expect(code).toBe(0);
    expect(cloud.fetchInvestigationReportFromCloud).not.toHaveBeenCalled();
  });

  it('returns 1 with a not-found message when the id is unknown', async () => {
    cloud.isCloudActive.mockReturnValue(false);
    db.getInvestigation.mockResolvedValue(null);

    const code = await runAsk('missing', 'why?', {});

    expect(code).toBe(1);
  });
});
