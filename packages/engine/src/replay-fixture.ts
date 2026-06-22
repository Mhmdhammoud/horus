/**
 * HOR-71 — First incident replay fixture with correlated evidence.
 *
 * A deterministic, fully-populated InvestigationReport representing one
 * realistic incident: a BullMQ worker concurrency increase that exhausted
 * the Redis connection pool and caused job stalls.
 *
 * Evidence spans three signal categories:
 *   - source (history + code): the git commit and the changed symbol
 *   - runtime (logs): the stall error from Elasticsearch
 *   - ownership: the file's maintainer from git history
 *
 * The changed file (`packages/connectors/src/bullmq/worker.ts`) resolves
 * to `@horus/connectors-team` via FIXTURE_CODEOWNERS_RULES — verifiable
 * offline using `resolveOwner` from @horus/core (HOR-69).
 *
 * Used by replay-fixture.test.ts (HOR-71) and any future replay/regression
 * tests that need a representative correlated report.
 */

import type { InvestigationReport } from './types.js';

/** Stable file path for the incident's changed component — matches FIXTURE_CODEOWNERS. */
export const INCIDENT_001_CHANGED_FILE = 'packages/connectors/src/bullmq/worker.ts';

/** Expected CODEOWNERS owner for INCIDENT_001_CHANGED_FILE (per FIXTURE_CODEOWNERS_RULES). */
export const INCIDENT_001_EXPECTED_OWNER = '@horus/connectors-team';

/**
 * Incident 001 — BullMQ stall from concurrency bump.
 *
 * A pre-built InvestigationReport for deterministic replay tests.
 * No live connector calls; all evidence is hardcoded.
 */
export const INCIDENT_001_FIXTURE: InvestigationReport = {
  id: 'incident-001-fixture',
  input: {
    hint: 'BullMQ workers stalling after deploy',
    service: 'leadcall-api',
  },
  summary:
    'BullMQ workers stalled in leadcall-api after a worker concurrency increase exhausted the Redis connection pool.',

  seeds: [
    {
      id: 'sym-001',
      name: 'BullMQWorkerConfig',
      filePath: 'packages/connectors/src/bullmq/worker.ts',
    },
  ],

  // -------------------------------------------------------------------------
  // Evidence — three signal categories
  // -------------------------------------------------------------------------
  evidence: [
    // Source: the commit that changed the concurrency setting
    {
      id: 'ev-001-commit',
      source: 'history',
      kind: 'commit',
      title: 'Increase BullMQ worker concurrency from 2 to 10',
      relevance: 0.85,
      payload: {
        hash: 'abc1234',
        message: 'Increase BullMQ worker concurrency from 2 to 10',
        author: 'Alice Chen',
        date: '2026-06-15T09:00:00.000Z',
      },
      links: {
        commit: 'abc1234',
        file: 'packages/connectors/src/bullmq/worker.ts',
      },
      provenance: {
        query: 'git log HEAD~1..HEAD',
        collectedAt: '2026-06-15T10:00:00.000Z',
      },
      priority: 'high',
    },

    // Runtime: the stall error captured from Elasticsearch logs
    {
      id: 'ev-002-log',
      source: 'logs',
      kind: 'log',
      title: 'BullMQ worker stalled: job exceeded lockDuration',
      relevance: 0.92,
      payload: {
        message: 'Job id=42 stalled after 30000ms',
        level: 'error',
        service: 'leadcall-api',
        eventCode: 'WORKER_STALLED',
      },
      links: { traceId: 'trace-bulkstall-001' },
      provenance: {
        query: 'es:leadcall-api-prod-* level>=error stall',
        collectedAt: '2026-06-15T10:01:00.000Z',
      },
      priority: 'critical',
    },

    // Source: the symbol in the changed file (code intelligence)
    {
      id: 'ev-003-symbol',
      source: 'code',
      kind: 'symbol',
      title: 'BullMQWorkerConfig — concurrency setting for the job processor',
      relevance: 0.70,
      payload: {
        filePath: 'packages/connectors/src/bullmq/worker.ts',
        symbolKind: 'interface',
      },
      links: {
        file: 'packages/connectors/src/bullmq/worker.ts',
        line: 42,
        symbolId: 'sym-001',
      },
      provenance: {
        query: 'source:BullMQWorkerConfig',
        collectedAt: '2026-06-15T10:00:00.000Z',
      },
    },
  ],

  timeline: {
    events: [],
    boundaryCrossings: [],
  },

  correlation: {
    groups: [],
    chains: [
      // Causal chain: commit → stall
      {
        id: 'chain-001',
        title: 'Concurrency bump → Redis pool exhaustion → worker stalls',
        evidenceIds: ['ev-001-commit', 'ev-002-log'],
        strength: 0.82,
        rationale: 'Deployment-regression: config change occurred within the stall onset window.',
      },
    ],
    missing: [],
  },

  findings: [
    {
      kind: 'correlation',
      title: 'Concurrency bump correlates with stall onset',
      confidence: 0.88,
      evidenceIds: ['ev-001-commit', 'ev-002-log'],
    },
    {
      kind: 'observation',
      title: 'Stalls confined to leadcall-api workers',
      confidence: 0.95,
      evidenceIds: ['ev-002-log'],
    },
    {
      kind: 'observation',
      title: 'Changed file is owned by connectors team',
      confidence: 0.90,
      evidenceIds: ['ev-003-symbol'],
    },
  ],

  suspectedCauses: [
    {
      id: 'cause-001',
      title: 'Redis connection pool exhausted under high concurrency',
      category: 'queue-backlog',
      sourceEvidenceIds: ['ev-001-commit', 'ev-002-log'],
      affectedNodeIds: [],
      baseScore: 0.75,
      finalScore: 0.81,
      confidence: 0.81,
      band: 'likely',
      explanations: [
        { factor: 'deployment-regression', delta: 0.15, reason: 'Deployment occurred within stall window' },
        { factor: 'evidence-quality', delta: -0.09, reason: 'No Redis state evidence to confirm pool exhaustion' },
      ],
    },
  ],

  hypotheses: [],
  similarIncidents: [],

  gapAnalysis: {
    gaps: [
      {
        dimension: 'state',
        why: 'No Redis state evidence to confirm connection pool exhaustion directly.',
        nextSource: 'Configure the Redis connector to collect key-level state.',
        confidenceImpact: 0.1,
      },
    ],
    blindSpots: ['Redis connection pool state cannot be verified without the state connector.'],
    confidenceCeiling: 0.9,
  },

  graph: { nodes: [], edges: [] },

  confidence: 0.78,

  nextActions: [
    'Roll back worker concurrency to 2 and confirm stall rate drops.',
    'Increase Redis max connection pool size before re-raising concurrency.',
    'Add a BullMQ stall-rate alert to catch future concurrency changes early.',
  ],

  // Ownership from git history — Alice Chen has 75% of commits to this file.
  ownership: {
    query: 'packages/connectors/src/bullmq/worker.ts',
    symbol: null,
    file: 'packages/connectors/src/bullmq/worker.ts',
    contributors: [
      {
        author: 'Alice Chen',
        commits: 12,
        firstDate: '2025-01-10T00:00:00.000Z',
        lastDate: '2026-06-14T09:30:00.000Z',
      },
      {
        author: 'Bob Smith',
        commits: 4,
        firstDate: '2025-03-01T00:00:00.000Z',
        lastDate: '2026-05-20T14:00:00.000Z',
      },
    ],
    likelyMaintainer: 'Alice Chen',
    maintainerShare: 0.75,
    mostActiveRecent: 'Alice Chen',
    confidence: 0.87,
    evidence: ['12 commits, latest 2026-06-14'],
    note: 'Likely maintainer based on commit frequency and recency.',
  },

  // Runtime source status — logs contributed, others not configured.
  sourceStatus: {
    sources: [
      { source: 'logs', configured: true, evidenceCount: 1, status: 'contributed' },
      { source: 'metrics', configured: false, evidenceCount: 0, status: 'not-configured' },
      { source: 'state', configured: false, evidenceCount: 0, status: 'not-configured' },
      { source: 'queue', configured: false, evidenceCount: 0, status: 'not-configured' },
    ],
  },
};
