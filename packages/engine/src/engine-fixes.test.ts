/**
 * Regression tests for three engine fixes:
 *
 *  - HOR-333: the deployment-regression cause cites the most-recent commit(s)
 *    (short SHA + subject) and the changed symbol name(s), not just the seed + range.
 *  - HOR-336 (extended): overall confidence ceiling is MONOTONIC in the headline
 *    suspected cause's finalScore — a weak headline reads lower than a strong one.
 *  - HOR-334: a behavioral "how does X work" hint with no incident signal points the
 *    user at `horus explain <symbol>` instead of dumping empty incident sections.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Symbol, SymbolContext, Flow, ImpactResult, ChangeSet, CypherResult, Evidence } from '@horus/core';
import type {
  CodeProvider,
  GitCommit,
  LogsProvider,
  LogAnalysis,
  MetricsProvider,
  MetricFinding,
} from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import type { BoundedGitChange } from './git-collector.js';

// ---------------------------------------------------------------------------
// collectGitChanges is mocked so the regression-citation test controls the
// bounded git history without touching a real repository.
// ---------------------------------------------------------------------------

vi.mock('./git-collector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-collector.js')>();
  return { ...actual, collectGitChanges: vi.fn(), defaultChangeWindowSince: vi.fn() };
});

import { investigate, confidenceCeilingForCause, looksExplanatory, looksPerformance, formatRegressionCitation, buildBehavioralWalkthrough, seedEmittedSeverityTier } from './engine.js';
import { collectGitChanges, defaultChangeWindowSince } from './git-collector.js';

const mockCollectGitChanges = vi.mocked(collectGitChanges);
const mockDefaultChangeWindowSince = vi.mocked(defaultChangeWindowSince);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED_SYMBOL: Symbol = {
  id: 'sym:services:SaleService',
  name: 'SaleService',
  filePath: 'src/services/sale.service.ts',
  startLine: 40,
  endLine: 120,
};

const fakeCtx: SymbolContext = {
  symbol: SEED_SYMBOL,
  callers: [],
  callees: [],
  imports: [],
  usesType: [],
  community: null,
  coupledWith: [],
};

function makeCommit(sha: string, subject: string, files: string[] = ['src/services/sale.service.ts']): GitCommit {
  return { sha, shortSha: sha.slice(0, 7), subject, author: 'Dev', dateIso: '2026-01-01', files };
}

function makeChangedSymbol(name: string): Symbol {
  return { id: `sym:services:${name}`, name, filePath: 'src/services/sale.service.ts', startLine: 50, endLine: 60 };
}

// Raise site of an arbitrary observed event_code — a DIFFERENT symbol than the seed, so
// GAP D (code→raise-site resolution) does not promote codes the seed doesn't raise.
const OTHER_RAISER: Symbol = {
  id: 'sym:other:someOtherFn',
  name: 'someOtherFn',
  filePath: 'src/other/other.service.ts',
  startLine: 5,
};

const baseCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() { return { ok: true, detail: 'fake' }; },
  // Realistic code→raise-site resolution (GAP D): a bare event_code resolves to its raise
  // site (a non-seed symbol here); a hint phrase resolves to the seed.
  async searchSymbols(query = '') { return /^[A-Z][A-Z0-9_]{3,}$/.test(query.trim()) ? [OTHER_RAISER] : [SEED_SYMBOL]; },
  async context() { return fakeCtx; },
  async impact(): Promise<ImpactResult> { return { target: SEED_SYMBOL, affected: 0, byDepth: [] }; },
  async flowsFor() { return []; },
  async detectChanges(): Promise<ChangeSet> { return { added: [], removed: [], modified: [] }; },
  async cypher(): Promise<CypherResult> { return { columns: [], rows: [], rowCount: 0 }; },
};

const fakeDb = {
  select() { return { from(_t: unknown) { return Promise.resolve([]); } }; },
  insert(_t: unknown) {
    return {
      values(_r: unknown) {
        return {
          returning(_c: unknown): Promise<{ id: string }[]> {
            return Promise.resolve([{ id: globalThis.crypto.randomUUID() }]);
          },
        };
      },
    };
  },
  update(_t: unknown) {
    return { set(_v: unknown) { return { where(_c: unknown): Promise<void> { return Promise.resolve(); } }; } };
  },
} as unknown as HorusDb;

// ---------------------------------------------------------------------------
// HOR-333: regression cause cites commit (short SHA + subject) + changed symbols
// ---------------------------------------------------------------------------

describe('investigate() — regression cause cites commit + changed functions (HOR-333)', () => {
  it('enriches the deployment-regression title with commit SHA, subject, and changed symbol names', async () => {
    mockCollectGitChanges.mockResolvedValue({
      commits: [
        makeCommit('a1b2c3d4e5f6', 'fix throttle'),
        makeCommit('99887766abcd', 'tidy imports'),
      ],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 10,
      totalDeletions: 3,
      window: { since: 'a1b2c3d', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const codeWithChanges: CodeProvider = {
      ...baseCode,
      async detectChanges(): Promise<ChangeSet> {
        return {
          added: [],
          removed: [],
          modified: [
            { before: makeChangedSymbol('activateSale'), after: makeChangedSymbol('activateSale') },
            { before: makeChangedSymbol('priceSale'), after: makeChangedSymbol('priceSale') },
          ],
        };
      },
    };

    const report = await investigate(
      { hint: 'SaleService regression', since: 'a1b2c3d' },
      { code: codeWithChanges, db: fakeDb, repoPath: '/repo' },
    );

    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression).toBeDefined();
    // Cites the most-recent commit short SHA + subject.
    expect(regression?.title).toContain('a1b2c3d');
    expect(regression?.title).toContain('"fix throttle"');
    // Cites the changed symbol name(s).
    expect(regression?.title).toContain('activateSale');
    // Still names the seed + range.
    expect(regression?.title).toContain('SaleService');
    expect(regression?.title).toContain('a1b2c3d..HEAD');
  });

  it('auto-derives a default change window when --since is absent, enabling the deployment-regression cause', async () => {
    // No explicit since: the engine asks for a default window anchored to the repo's last commit.
    mockDefaultChangeWindowSince.mockResolvedValue('2025-12-18T00:00:00.000Z');
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('a1b2c3d4e5f6', 'fix throttle')],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 5,
      totalDeletions: 1,
      window: { since: '2025-12-18T00:00:00.000Z', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    // The default window was requested (NOT a bare wall-clock read) and the change window ran.
    expect(mockDefaultChangeWindowSince).toHaveBeenCalledWith('/repo', 14);
    expect(report.recentChanges).toBeDefined();
    // The deployment-regression cause is no longer dormant; it labels the relative window.
    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression).toBeDefined();
    expect(regression?.title).toContain('the last 14 days');
    expect(regression?.title).not.toContain('undefined');
  });

  it('honors deps.changeWindowDays as an overridable default window length', async () => {
    mockDefaultChangeWindowSince.mockResolvedValue('2025-12-25T00:00:00.000Z');
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('a1b2c3d4e5f6', 'fix throttle')],
      fileStats: [],
      changedFiles: [],
      totalInsertions: 0,
      totalDeletions: 0,
      window: { since: '2025-12-25T00:00:00.000Z', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression' },
      { code: baseCode, db: fakeDb, repoPath: '/repo', changeWindowDays: 7 },
    );

    expect(mockDefaultChangeWindowSince).toHaveBeenCalledWith('/repo', 7);
    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression?.title).toContain('the last 7 days');
  });

  it('does not auto-derive a window when --since is explicit (explicit behavior unchanged)', async () => {
    // Call history accumulates across tests (no global clearMocks) — reset before asserting.
    mockDefaultChangeWindowSince.mockClear();
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('a1b2c3d4e5f6', 'fix throttle')],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 1,
      totalDeletions: 0,
      window: { since: 'a1b2c3d', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    await investigate(
      { hint: 'SaleService regression', since: 'a1b2c3d' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    expect(mockDefaultChangeWindowSince).not.toHaveBeenCalled();
    expect(mockCollectGitChanges).toHaveBeenCalledWith({ repoPath: '/repo', since: 'a1b2c3d' });
  });

  it('degrades to the plain title when no commits/changed symbols are available', () => {
    const { commitClause, symbolClause } = formatRegressionCitation(undefined, null);
    expect(commitClause).toBe('');
    expect(symbolClause).toBe('');
  });

  it('bounds the citation to 2 commits and 3 symbols', () => {
    const recent = {
      commits: [
        makeCommit('1111111', 'one'),
        makeCommit('2222222', 'two'),
        makeCommit('3333333', 'three'),
      ],
      fileStats: [],
      changedFiles: [],
      totalInsertions: 0,
      totalDeletions: 0,
      window: { since: 'x', until: undefined },
      truncated: false,
    } as BoundedGitChange;
    const changes: ChangeSet = {
      added: [],
      removed: [],
      modified: ['a', 'b', 'c', 'd'].map((n) => ({ before: makeChangedSymbol(n), after: makeChangedSymbol(n) })),
    };
    const { commitClause, symbolClause } = formatRegressionCitation(recent, changes);
    // Only the first 2 commits appear; the third does not.
    expect(commitClause).toContain('1111111');
    expect(commitClause).toContain('2222222');
    expect(commitClause).not.toContain('3333333');
    // Only the first 3 symbols are named, with a "…" overflow marker.
    expect(symbolClause).toContain('a, b, c');
    expect(symbolClause).not.toContain('d,');
    expect(symbolClause).toContain('…');
  });

  it('#3: attributes only to commits/symbols touching the seed file, not the newest in-window', () => {
    const seedFile = 'src/services/sale.service.ts';
    const recent = {
      // newest-first; the newest commit touched an UNRELATED file, the older one the seed file.
      commits: [
        makeCommit('newaaaa', 'newest, unrelated file', ['src/other/x.ts']),
        makeCommit('touchbb', 'the real change to the seed', [seedFile]),
      ],
      fileStats: [],
      changedFiles: [seedFile, 'src/other/x.ts'],
      totalInsertions: 0,
      totalDeletions: 0,
      window: { since: 'x', until: undefined },
      truncated: false,
    } as BoundedGitChange;
    const unrelated: Symbol = { id: 's:x', name: 'unrelatedFn', filePath: 'src/other/x.ts', startLine: 1, endLine: 2 };
    const changes: ChangeSet = {
      added: [],
      removed: [],
      modified: [
        { before: unrelated, after: unrelated },
        { before: makeChangedSymbol('manageSales'), after: makeChangedSymbol('manageSales') },
      ],
    };
    const { commitClause, symbolClause } = formatRegressionCitation(recent, changes, seedFile);
    // Blame the seed-touching commit, NOT the newest unrelated-file commit.
    expect(commitClause).toContain('touchbb');
    expect(commitClause).not.toContain('newaaaa');
    // Changed symbols restricted to the seed file.
    expect(symbolClause).toContain('manageSales');
    expect(symbolClause).not.toContain('unrelatedFn');
  });
});

// ---------------------------------------------------------------------------
// HOR-336 (extended): confidence ceiling tracks the headline cause strength.
// ---------------------------------------------------------------------------

describe('confidenceCeilingForCause — monotonic ceiling bound to headline cause score', () => {
  it('is monotonic non-decreasing in the cause score', () => {
    const samples = [0, 0.1, 0.19, 0.2, 0.3, 0.4, 0.49, 0.5, 0.6, 0.7, 0.84, 0.85, 0.95, 1];
    for (let i = 1; i < samples.length; i++) {
      const prev = confidenceCeilingForCause(samples[i - 1]!);
      const cur = confidenceCeilingForCause(samples[i]!);
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });

  it('caps a sub-threshold cause to 0.6 (preserves HOR-336)', () => {
    expect(confidenceCeilingForCause(0.08)).toBeCloseTo(0.6, 5);
    expect(confidenceCeilingForCause(0.19)).toBeCloseTo(0.6, 5);
  });

  it('caps a modest cause (0.2–0.5) to roughly the 0.6–0.78 range', () => {
    expect(confidenceCeilingForCause(0.2)).toBeCloseTo(0.6, 5);
    expect(confidenceCeilingForCause(0.35)).toBeGreaterThan(0.6);
    expect(confidenceCeilingForCause(0.35)).toBeLessThan(0.78);
    expect(confidenceCeilingForCause(0.49)).toBeLessThanOrEqual(0.78);
  });

  it('permits high confidence only for a strong cause (>=~0.5)', () => {
    expect(confidenceCeilingForCause(0.5)).toBeGreaterThanOrEqual(0.78);
    expect(confidenceCeilingForCause(0.9)).toBeCloseTo(1, 5);
  });
});

function queueProvider(waiting: number, active: number) {
  return {
    async discoverQueues() { return ['SaleQueue']; },
    async analyzeQueues() {
      return {
        prefix: 'bull',
        collectedAt: new Date().toISOString(),
        queues: [
          {
            queueName: 'SaleQueue',
            waiting,
            active,
            failed: 0,
            completed: 0,
            delayed: 0,
            paused: 0,
            isPaused: false,
          },
        ],
      };
    },
  } as unknown as Parameters<typeof investigate>[1]['queue'];
}

// A logs provider with no error signatures + a metrics provider that checked
// cleanly: these close the logs + metrics evidence gaps (raising the gap-analysis
// confidence ceiling) WITHOUT contributing any incident signal, so the headline
// cause's strength — not gap noise — becomes the binding confidence constraint.
const quietLogs: LogsProvider = {
  id: 'fake-logs',
  kind: 'logs',
  async health() { return { ok: true, detail: 'fake' }; },
  async searchLogs() { return []; },
  async aggregateErrors() { return []; },
  async errorDeltas() { return []; },
  async analyzeErrors(): Promise<LogAnalysis> {
    return {
      window: { from: 'x', to: 'y' },
      totalErrors: 4,
      signatures: [
        {
          key: 'SALE_ACTIVATE_FAIL',
          count: 4,
          firstSeen: '2026-06-13T10:00:00.000Z',
          lastSeen: '2026-06-13T15:00:00.000Z',
          services: ['sale-service'],
          isNew: false,
          baselineCount: 4,
          sampleMessage: 'sale activation failed',
        },
      ],
      newSignatures: [],
      affectedServices: ['sale-service'],
    };
  },
  async checkCompatibility() { return { ok: true, indexCount: 1, issues: [] }; },
  toEvidence() { return []; },
  async queryEvidence() { return []; },
};

function makeNoneMetrics(): MetricsProvider {
  const findings: MetricFinding[] = [
    {
      dashboardUid: 'dash-1',
      panelTitle: 'sale-service p99 latency',
      kind: 'latency',
      anomaly: 'none',
      labels: {},
      baselineAvg: 0.05,
      currentAvg: 0.05,
      ratio: 1,
      lastValue: 0.05,
    },
  ];
  return {
    id: 'grafana',
    kind: 'metrics',
    async health() { return { ok: true, detail: 'fake' }; },
    async findPanels() { return []; },
    async analyze() { return findings; },
    async rawRange() { return []; },
    toEvidence(fs: MetricFinding[]): Evidence[] {
      return fs.filter((f) => f.anomaly !== 'none').map((f, i): Evidence => ({
        id: `ev_metric_${i}`,
        source: 'metrics',
        kind: 'metric',
        title: f.panelTitle,
        relevance: 0.85,
        payload: f,
        links: {},
        provenance: { query: 'grafana.analyze', collectedAt: new Date().toISOString() },
      }));
    },
  } as unknown as MetricsProvider;
}

describe('investigate() — an unlinked (co-occurring) headline is capped regardless of raw strength', () => {
  it('a strong but seed-UNLINKED cause does not escalate confidence past the "possible" band', async () => {
    // Both runs share the same evidence-gap profile (logs + metrics checked, same
    // missing connectors), so the gap-analysis ceiling is identical. They differ ONLY
    // in headline-cause strength: the WEAK run has a healthy queue (no backlog cause),
    // the STRONG run a deep backlog (strong queue-backlog cause). The monotonic
    // cause-ceiling therefore drives the confidence difference.
    const deps = { code: baseCode, db: fakeDb, logs: quietLogs, metrics: makeNoneMetrics() };
    const weakReport = await investigate(
      { hint: 'SaleService' },
      { ...deps, queue: queueProvider(0, 3) }, // healthy: no backlog/starvation cause
    );
    const strongReport = await investigate(
      { hint: 'SaleService' },
      { ...deps, queue: queueProvider(5000, 2) }, // deep backlog: strong cause
    );

    const weakTop = weakReport.suspectedCauses[0]?.finalScore ?? 0;
    const strongTop = strongReport.suspectedCauses[0]?.finalScore ?? 0;
    // Sanity: the strong run genuinely has a stronger headline cause.
    expect(strongTop).toBeGreaterThan(weakTop);
    // #1/#2: neither queue-backlog cause is structurally LINKED to the SaleService seed (no
    // direct log / seed evidence / graph edge), so both headlines are co-occurring signals.
    // Confidence is therefore capped in the "possible" band and does NOT escalate with raw
    // cause strength — the confident-but-wrong "likely" headline from a loud unlinked signal is
    // exactly the gap this closes.
    expect(strongReport.confidence).toBeLessThanOrEqual(0.6);
    expect(weakReport.confidence).toBeLessThanOrEqual(0.6);
  });
});

// ---------------------------------------------------------------------------
// HOR-334: behavioral "how does X work" hint routes to `horus explain`.
// ---------------------------------------------------------------------------

describe('looksExplanatory — detects interrogative/explanatory hints', () => {
  it('matches "how does X work" style questions', () => {
    expect(looksExplanatory('how does SaleService work')).toBe(true);
    expect(looksExplanatory('what happens when a sale is activated')).toBe(true);
    expect(looksExplanatory('explain the checkout flow')).toBe(true);
    expect(looksExplanatory('walk me through SaleService')).toBe(true);
  });

  it('does NOT match an ordinary incident hint', () => {
    expect(looksExplanatory('SaleService is throwing 500s')).toBe(false);
    expect(looksExplanatory('checkout latency spike')).toBe(false);
    expect(looksExplanatory('')).toBe(false);
  });

  it('gap E: a leading interrogative carrying FAULT terms is an incident hunt, not an explanation', () => {
    expect(looksExplanatory('what recently changed that could be breaking product sync')).toBe(false);
    expect(looksExplanatory('what is causing the product errors')).toBe(false);
    expect(looksExplanatory('why are products failing to publish')).toBe(false);
    expect(looksExplanatory('what changed in the auth flow')).toBe(false);
    // genuine explanation requests are still behavioral, even when they mention a failure path
    expect(looksExplanatory('how does the retry-on-failure path work')).toBe(true);
    expect(looksExplanatory('what happens when a payment fails')).toBe(true);
    expect(looksExplanatory('explain how error handling works')).toBe(true);
    // a clean interrogative with no fault terms stays explanatory
    expect(looksExplanatory('what is the order pipeline')).toBe(true);
  });
});

describe('looksPerformance — detects latency/performance hints (gap 4)', () => {
  it('matches performance hints, not ordinary incidents', () => {
    expect(looksPerformance('everything is slow')).toBe(true);
    expect(looksPerformance('high latency on checkout')).toBe(true);
    expect(looksPerformance('p99 degraded')).toBe(true);
    expect(looksPerformance('throughput dropped')).toBe(true);
    expect(looksPerformance('order creation throwing 500s')).toBe(false);
    expect(looksPerformance('zoho oauth callback')).toBe(false);
  });
});

describe('investigate() — behavioral "how does X work" hint routes to a flow walkthrough (gap #5)', () => {
  it('produces a flow walkthrough instead of an incident headline', async () => {
    const report = await investigate(
      { hint: 'how does SaleService work' },
      { code: baseCode, db: fakeDb },
    );
    expect(report.behavioral).toBeDefined();
    expect(report.summary.toLowerCase()).toContain('how does it work');
    expect(report.summary).not.toContain('Top suspected cause');
    expect(report.nextActions.some((a) => a.includes('horus explain'))).toBe(true);
  });

  it('routes to the walkthrough even when incident signals are present, with a noisy-signal note', async () => {
    // gap #5: ambient incident noise (a failing queue) must NOT suppress an explanatory hint —
    // the old gate did, so the behavioral branch never fired in production. The walkthrough still
    // flags the live error signals so the user can pivot to a fault hunt.
    const failingQueue = {
      async discoverQueues() { return ['SaleQueue']; },
      async analyzeQueues() {
        return {
          prefix: 'bull',
          collectedAt: new Date().toISOString(),
          queues: [
            {
              queueName: 'SaleQueue',
              waiting: 500,
              active: 0,
              failed: 100,
              completed: 0,
              delayed: 0,
              paused: 0,
              isPaused: false,
            },
          ],
        };
      },
    } as unknown as Parameters<typeof investigate>[1]['queue'];

    const report = await investigate(
      { hint: 'how does SaleService work' },
      { code: baseCode, db: fakeDb, queue: failingQueue },
    );
    expect(report.behavioral).toBeDefined();
    expect(report.summary).toMatch(/error signals|fault hunt/i);
    expect(report.summary).not.toContain('Top suspected cause');
  });
});

describe('buildBehavioralWalkthrough (gap #5)', () => {
  const sym = (name: string, filePath: string): Symbol => ({ id: `${name}:${filePath}`, name, filePath, startLine: 1 });

  it('renders the richest flow, filters logger noise, and detects persistence + external calls', () => {
    const flows: Flow[] = [
      {
        id: 'f1',
        name: 'order-create',
        steps: [
          sym('OrderController', 'src/order/order.controller.ts'),
          sym('createOrder', 'src/order/order.service.ts'),
          sym('forContext', 'src/common/logging/logger.service.ts'), // logger — must be filtered out
          sym('save', 'src/order/order.repository.ts'), // persistence
          sym('postWebhook', 'src/shopify/shopify.client.ts'), // external call
        ],
      },
    ];
    const w = buildBehavioralWalkthrough(
      'how does order creation work',
      sym('createOrder', 'src/order/order.service.ts'),
      undefined,
      flows,
    );
    expect(w.entry?.name).toBe('OrderController'); // roots at the flow entry, not the mid-flow seed
    expect(w.steps.map((s) => s.name)).not.toContain('forContext'); // logger filtered
    expect(w.persistence.join(' ')).toContain('save');
    expect(w.persistence.join(' ')).not.toContain('createOrder'); // generic service verb not over-flagged
    expect(w.externalCalls.join(' ')).toContain('postWebhook');
    expect(w.narrative).toContain('Flow:');
  });

  it('falls back to the seed + its de-noised callees when no multi-step flow exists', () => {
    const seed = sym('handleThing', 'src/x.service.ts');
    const ctx = {
      callees: [sym('doWork', 'src/y.service.ts'), sym('forContext', 'src/common/logger.service.ts')],
    } as unknown as SymbolContext;
    const w = buildBehavioralWalkthrough('how does X work', seed, ctx, []);
    expect(w.entry?.name).toBe('handleThing');
    expect(w.steps.map((s) => s.name)).toContain('doWork');
    expect(w.steps.map((s) => s.name)).not.toContain('forContext');
  });

  it('gap C: lists a class seed\'s methods as the entry points instead of collapsing to the class', () => {
    const cls: Symbol = {
      id: 'class:src/zoho/oauth.service.ts:ZohoOAuthService',
      name: 'ZohoOAuthService',
      filePath: 'src/zoho/oauth.service.ts',
      startLine: 10,
    };
    const methods = [
      sym('exchangeCodeForTokens', 'src/zoho/oauth.service.ts'),
      sym('refreshAccessToken', 'src/zoho/oauth.service.ts'),
    ];
    const w = buildBehavioralWalkthrough('how does zoho oauth work', cls, undefined, [], methods);
    expect(w.narrative).toContain('is a class');
    expect(w.narrative).toContain('exchangeCodeForTokens');
    expect(w.narrative).toContain('refreshAccessToken');
    expect(w.narrative).not.toContain('showing its direct calls');
  });
});

describe('seedEmittedSeverityTier (gap A — severity-aware cross-signal join)', () => {
  const ERROR = 2;
  const WARN = 1;
  const INFO = 0;

  it('uses the ES log level when present (level overrides the code prefix)', () => {
    expect(seedEmittedSeverityTier('error', 'W_FOO', 'x')).toBe(ERROR);
    expect(seedEmittedSeverityTier('fatal', 'D_FOO', 'x')).toBe(ERROR);
    expect(seedEmittedSeverityTier('warn', 'E_FOO', 'x')).toBe(WARN);
    expect(seedEmittedSeverityTier('debug', 'E_FOO', 'x')).toBe(INFO);
    expect(seedEmittedSeverityTier('info', 'X', '')).toBe(INFO);
  });

  it('falls back to the event_code prefix convention when no level', () => {
    expect(seedEmittedSeverityTier(null, 'E_FULFILLMENT_SYNC_ERROR_04', 'Error during sync')).toBe(ERROR);
    expect(seedEmittedSeverityTier(null, 'W_FULFILLMENT_SYNC_SKIP_02', 'Order not found, skipping')).toBe(WARN);
    expect(seedEmittedSeverityTier(null, 'D_FULFILLMENT_SYNC_ORDER_02', 'Processing order')).toBe(INFO);
  });

  it('treats unclassifiable codes as error — never silently downgrades a real failure', () => {
    // leadcall's HTTP_FLT_001 is logged via logger.error but has no E_/W_/D_ prefix.
    expect(seedEmittedSeverityTier(null, 'HTTP_FLT_001', 'request failed')).toBe(ERROR);
    expect(seedEmittedSeverityTier(undefined, 'SOMECODE', '')).toBe(ERROR);
  });

  it('downgrades on positive keyword evidence only (no prefix/level)', () => {
    expect(seedEmittedSeverityTier(null, 'SOMECODE', 'skipping sync, nothing to do')).toBe(INFO);
    expect(seedEmittedSeverityTier(null, 'SOMECODE', 'a warning about config')).toBe(WARN);
  });
});
