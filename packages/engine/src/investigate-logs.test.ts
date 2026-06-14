/**
 * HOR-13 — Integration test: investigate() with real runtime log evidence.
 *
 * Exercises the logs branch of the engine end-to-end using fake providers
 * (no network / DB I/O). Also acts as a regression guard to confirm that
 * calling investigate() WITHOUT a logs provider keeps the "logs" gap present.
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { LogsProvider, LogRecord, ErrorBucket, LogAnalysis } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import { investigate, logWindowFrom } from './engine.js';

// ---------------------------------------------------------------------------
// Fake CodeProvider
// ---------------------------------------------------------------------------

const FAKE_SYMBOL: Symbol = {
  id: 'sym:fake:ZohoSyncWorker',
  name: 'ZohoSyncWorker',
  filePath: 'src/workers/zoho-sync.worker.ts',
  startLine: 10,
};

const FAKE_CTX: SymbolContext = {
  symbol: FAKE_SYMBOL,
  callers: [],
  callees: [],
  imports: [],
  usesType: [],
  community: null,
  coupledWith: [],
};

const FAKE_IMPACT: ImpactResult = {
  target: FAKE_SYMBOL,
  affected: 0,
  byDepth: [],
};

const FAKE_CHANGE_SET: ChangeSet = {
  added: [],
  removed: [],
  modified: [],
};

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',

  async health() {
    return { ok: true, detail: 'fake code provider' };
  },
  async searchSymbols(_query: string, _limit?: number): Promise<Symbol[]> {
    return [FAKE_SYMBOL];
  },
  async context(_symbolId: string): Promise<SymbolContext> {
    return FAKE_CTX;
  },
  async impact(_symbolId: string, _depth?: number): Promise<ImpactResult> {
    return FAKE_IMPACT;
  },
  async flowsFor(_symbolId: string) {
    return [];
  },
  async detectChanges(_diff: { base: string; compare: string }): Promise<ChangeSet> {
    return FAKE_CHANGE_SET;
  },
  async cypher(_query: string): Promise<CypherResult> {
    return { columns: [], rows: [], rowCount: 0 };
  },
};

// ---------------------------------------------------------------------------
// Fake HorusDb
//
// persist() inside engine.ts is wrapped in try/catch and returns null on any
// DB failure. So we provide a minimal stub that throws on all operations;
// the engine handles this gracefully and still returns the report.
// recallSimilar and storeIncidentMemory are also try/catch-wrapped.
// listQueueEdges does db.select().from(queueEdges) — we stub that too.
// ---------------------------------------------------------------------------

const fakeDb = {
  // Drizzle fluent-query stubs — each method returns `this` for chaining.
  select() {
    return {
      from(_table: unknown) {
        return Promise.resolve([]);
      },
    };
  },
  insert(_table: unknown) {
    return {
      values(_rows: unknown) {
        return {
          returning(_cols: unknown): Promise<{ id: string }[]> {
            return Promise.resolve([{ id: globalThis.crypto.randomUUID() }]);
          },
        };
      },
    };
  },
  update(_table: unknown) {
    return {
      set(_vals: unknown) {
        return {
          where(_cond: unknown): Promise<void> {
            return Promise.resolve();
          },
        };
      },
    };
  },
} as unknown as HorusDb;

// ---------------------------------------------------------------------------
// Fake LogsProvider
// ---------------------------------------------------------------------------

const FAKE_LOG_ERROR: LogRecord = {
  timestamp: new Date(Date.now() - 300_000).toISOString(),
  level: 'error',
  levelValue: 50,
  message: 'Zoho API returned 503 Service Unavailable',
  service: 'leadcall-api-prod',
  component: 'ZohoSyncWorker',
  eventCode: 'HTTPFLT001',
  host: 'worker-01',
  index: 'logs-2026.06',
  raw: {},
};

const FAKE_LOG_INFO: LogRecord = {
  timestamp: new Date(Date.now() - 600_000).toISOString(),
  level: 'info',
  levelValue: 30,
  message: 'Processing zoho sync job',
  service: 'leadcall-api-prod',
  component: 'ZohoSyncWorker',
  eventCode: undefined,
  host: 'worker-01',
  index: 'logs-2026.06',
  raw: {},
};

const FAKE_BUCKET: ErrorBucket = { key: 'HTTPFLT001', count: 9 };

// HOR-10: the engine now consumes synthesized error SIGNATURES, not raw lines.
const FAKE_ANALYSIS: LogAnalysis = {
  window: { from: 'x', to: 'y' },
  totalErrors: 14,
  signatures: [
    {
      key: 'HTTPFLT001',
      count: 9,
      firstSeen: '2026-06-13T10:00:00.000Z',
      lastSeen: '2026-06-13T15:00:00.000Z',
      services: ['leadcall-api-prod'],
      isNew: true,
      baselineCount: 0,
      ratio: Infinity,
      sampleMessage: 'Zoho API returned 503 Service Unavailable',
    },
    {
      key: 'DBPOOL02',
      count: 5,
      firstSeen: '2026-06-13T09:00:00.000Z',
      lastSeen: '2026-06-13T14:00:00.000Z',
      services: ['leadcall-api-prod'],
      isNew: false,
      baselineCount: 2,
      ratio: 2.5,
    },
  ],
  newSignatures: ['HTTPFLT001'],
  affectedServices: ['leadcall-api-prod'],
};

const fakeLogs: LogsProvider = {
  id: 'fake-logs',
  kind: 'logs',

  async health() {
    return { ok: true, detail: 'fake logs provider' };
  },
  async searchLogs(_q) {
    return [FAKE_LOG_ERROR, FAKE_LOG_INFO];
  },
  async aggregateErrors(_q, _field?) {
    return [FAKE_BUCKET];
  },
  async errorDeltas(_baseline, _current, _field?) {
    return [];
  },
  async analyzeErrors(_q, _field?) {
    return FAKE_ANALYSIS;
  },
  toEvidence(_records) {
    return [];
  },
};

// ---------------------------------------------------------------------------
// Tests: WITH logs provider
// ---------------------------------------------------------------------------

describe('investigate() WITH logs provider (HOR-13)', () => {
  it('includes log evidence in the report', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const logEvidence = report.evidence.filter((e) => e.kind === 'log');
    expect(logEvidence.length).toBeGreaterThan(0);
  });

  it('a NEW error signature yields evidence with relevance 0.95', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const newSigEv = report.evidence.find(
      (e) => e.kind === 'log' && e.relevance === 0.95,
    );
    expect(newSigEv).toBeDefined();
    expect(newSigEv?.title).toContain('HTTPFLT001');
    expect(newSigEv?.title).toContain('NEW');
  });

  it('a spiking (non-new) error signature yields evidence with relevance 0.9', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const spikeEv = report.evidence.find(
      (e) => e.kind === 'log' && e.relevance === 0.9,
    );
    expect(spikeEv).toBeDefined();
    expect(spikeEv?.title).toContain('DBPOOL02');
  });

  it('clears the logs gap (no gap with dimension "logs")', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeUndefined();
  });

  it('all gaps have dimension !== "logs"', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    for (const gap of report.gapAnalysis.gaps) {
      expect(gap.dimension).not.toBe('logs');
    }
  });

  it('includes an observation finding summarizing the error signatures', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const logFinding = report.findings.find((f) =>
      f.title.toLowerCase().includes('error signature'),
    );
    expect(logFinding).toBeDefined();
    expect(logFinding?.kind).toBe('observation');
    // 2 signatures, 1 new, 14 errors
    expect(logFinding?.title).toContain('1 new');
  });

  it('includes an anomaly finding naming the top error signature', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const anomalyFinding = report.findings.find(
      (f) => f.kind === 'anomaly' && f.title.includes('HTTPFLT001'),
    );
    expect(anomalyFinding).toBeDefined();
    expect(anomalyFinding?.title).toContain('NEW');
  });

  it('confidence ceiling is not reduced by the logs gap (since logs are present)', async () => {
    // Run without logs to get the baseline ceiling reduction caused by the logs gap.
    const reportNoLogs = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );
    const ceilingNoLogs = reportNoLogs.gapAnalysis.confidenceCeiling;

    // With logs, the ceiling should be higher (logs gap impact = 0.1 removed).
    const reportWithLogs = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );
    const ceilingWithLogs = reportWithLogs.gapAnalysis.confidenceCeiling;

    expect(ceilingWithLogs).toBeGreaterThan(ceilingNoLogs);
  });
});

// ---------------------------------------------------------------------------
// Tests: WITHOUT logs provider (regression guard)
// ---------------------------------------------------------------------------

describe('investigate() WITHOUT logs provider (regression guard)', () => {
  it('returns a valid report with no log evidence', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );

    const logEvidence = report.evidence.filter((e) => e.kind === 'log');
    expect(logEvidence).toHaveLength(0);
  });

  it('the "logs" gap is present when no logs provider is supplied', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );

    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
  });

  it('report.confidence is defined and between 0 and 1', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );

    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(1);
  });

  it('report has seeds resolved from the fake code provider', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );

    expect(report.seeds.length).toBeGreaterThan(0);
    const firstSeed = report.seeds[0];
    expect(firstSeed).toBeDefined();
    expect(firstSeed?.name).toBe('ZohoSyncWorker');
  });

  it('passes logs: null explicitly (treated same as omitted)', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: null },
    );

    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: logWindowFrom helper
// ---------------------------------------------------------------------------

describe('logWindowFrom', () => {
  it('parses "24h" into a timestamp ~24h ago', () => {
    const before = Date.now();
    const result = logWindowFrom('24h');
    const after = Date.now();
    const ts = new Date(result).getTime();
    const expected24h = 24 * 3_600_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected24h - 100);
    expect(ts).toBeLessThanOrEqual(after - expected24h + 100);
  });

  it('parses "7d" into a timestamp ~7 days ago', () => {
    const before = Date.now();
    const result = logWindowFrom('7d');
    const ts = new Date(result).getTime();
    const expected7d = 7 * 86_400_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected7d - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected7d + 100);
  });

  it('parses "30m" into a timestamp ~30 min ago', () => {
    const before = Date.now();
    const result = logWindowFrom('30m');
    const ts = new Date(result).getTime();
    const expected30m = 30 * 60_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected30m - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected30m + 100);
  });

  it('parses "90s" into a timestamp ~90 sec ago', () => {
    const before = Date.now();
    const result = logWindowFrom('90s');
    const ts = new Date(result).getTime();
    const expected90s = 90 * 1_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected90s - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected90s + 100);
  });

  it('defaults to ~7 days ago for undefined', () => {
    const before = Date.now();
    const result = logWindowFrom(undefined);
    const ts = new Date(result).getTime();
    const expected7d = 7 * 86_400_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected7d - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected7d + 100);
  });

  it('defaults to ~7 days ago for a git ref like "HEAD~5"', () => {
    const before = Date.now();
    const result = logWindowFrom('HEAD~5');
    const ts = new Date(result).getTime();
    const expected7d = 7 * 86_400_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected7d - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected7d + 100);
  });

  it('returns an ISO-8601 string', () => {
    const result = logWindowFrom('1h');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
