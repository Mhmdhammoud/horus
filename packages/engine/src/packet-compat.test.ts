/**
 * HOR-95 — Investigation packet compatibility tests.
 *
 * Protects replay, postmortem, and AI narrative input from accidental packet
 * compatibility regressions. Three canonical packet variants are tested:
 *
 *   1. source-only   — code/history evidence only; no runtime sources, no
 *                      optional fields (sourceStatus, ownership).
 *   2. runtime-summary — adds sourceStatus and runtime log evidence.
 *   3. change-summary  — adds commit evidence and nextActions.
 *
 * Legacy compatibility test:
 *   • Pre-v0.1 packet missing nextActions is normalised by migrateReport so
 *     generatePostmortem never crashes on the missing field.
 *
 * All fixtures are synthetic — no live connectors or DB.
 */

import { describe, it, expect } from 'vitest';
import type { InvestigationReport } from './types.js';
import type { Evidence } from '@horus/core';
import { generatePostmortem } from './postmortem.js';
import { migrateReport } from './migrate-report.js';
import { INCIDENT_001_FIXTURE } from './replay-fixture.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ev(
  id: string,
  source: Evidence['source'],
  kind: string,
  title: string,
): Evidence {
  return {
    id,
    source,
    kind: kind as Evidence['kind'],
    title,
    relevance: 0.7,
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: '2026-06-15T10:00:00Z' },
  };
}

// ---------------------------------------------------------------------------
// Packet variants
// ---------------------------------------------------------------------------

/** Minimal source-only packet — no runtime, no optional fields. */
const SOURCE_ONLY_PACKET: InvestigationReport = {
  id: 'compat-source-only',
  input: { hint: 'slowdown in payment-service' },
  summary: 'Structural evidence only — no runtime sources configured.',
  seeds: [{ id: 'sym-x', name: 'PaymentProcessor', filePath: 'src/payment.ts' }],
  evidence: [
    ev('ev-sym', 'code', 'symbol', 'PaymentProcessor — entry point for payments'),
  ],
  timeline: { events: [], boundaryCrossings: [] },
  correlation: { groups: [], chains: [], missing: [] },
  findings: [
    { kind: 'observation', title: 'Symbol identified', confidence: 0.6, evidenceIds: ['ev-sym'] },
  ],
  suspectedCauses: [],
  hypotheses: [],
  similarIncidents: [],
  gapAnalysis: {
    gaps: [
      {
        dimension: 'logs',
        why: 'Elasticsearch not configured.',
        nextSource: 'Configure Elasticsearch connector.',
        confidenceImpact: 0.2,
      },
    ],
    blindSpots: ['No runtime log evidence.'],
    confidenceCeiling: 0.6,
  },
  graph: { nodes: [], edges: [] },
  confidence: 0.3,
  nextActions: [],
};

/** Runtime-summary packet — adds sourceStatus and log evidence. */
const RUNTIME_PACKET: InvestigationReport = {
  ...SOURCE_ONLY_PACKET,
  id: 'compat-runtime',
  evidence: [
    ev('ev-sym', 'code', 'symbol', 'PaymentProcessor — entry point'),
    ev('ev-log', 'logs', 'log', 'Payment gateway timeout: 3x in last 5 min'),
  ],
  sourceStatus: {
    sources: [
      { source: 'logs', status: 'contributed', configured: true, evidenceCount: 1 },
      { source: 'metrics', status: 'not-configured', configured: false, evidenceCount: 0 },
      { source: 'state', status: 'not-configured', configured: false, evidenceCount: 0 },
      { source: 'queue', status: 'not-configured', configured: false, evidenceCount: 0 },
    ],
  },
  gapAnalysis: {
    gaps: [
      {
        dimension: 'metrics',
        why: 'No Grafana connection for latency percentiles.',
        nextSource: 'Wire Grafana connector.',
        confidenceImpact: 0.15,
      },
    ],
    blindSpots: ['Cannot quantify latency impact without metrics.'],
    confidenceCeiling: 0.8,
  },
  confidence: 0.55,
  nextActions: [],
};

/** Change-summary packet — adds commit evidence and nextActions. */
const CHANGE_PACKET: InvestigationReport = {
  ...SOURCE_ONLY_PACKET,
  id: 'compat-change',
  evidence: [
    ev('ev-sym', 'code', 'symbol', 'PaymentProcessor — entry point'),
    ev('ev-commit', 'history', 'commit', 'Bump gateway timeout from 3s to 10s'),
  ],
  findings: [
    { kind: 'observation', title: 'Symbol identified', confidence: 0.6, evidenceIds: ['ev-sym'] },
    { kind: 'correlation', title: 'Timeout bump correlates with slowdown', confidence: 0.7, evidenceIds: ['ev-commit', 'ev-sym'] },
  ],
  suspectedCauses: [
    {
      id: 'cause-001',
      title: 'Gateway timeout increase caused cascading delays',
      category: 'configuration',
      sourceEvidenceIds: ['ev-commit'],
      affectedNodeIds: [],
      baseScore: 0.6,
      finalScore: 0.72,
      confidence: 0.72,
      band: 'likely',
      explanations: [],
    },
  ],
  confidence: 0.62,
  nextActions: [
    'Revert gateway timeout to 3s and monitor',
    'Add alerting for gateway p99 > 5s',
  ],
};

// ---------------------------------------------------------------------------
// 1. Source-only packet
// ---------------------------------------------------------------------------

describe('packet-compat — source-only packet', () => {
  it('generatePostmortem does not throw on source-only packet', () => {
    expect(() => generatePostmortem(SOURCE_ONLY_PACKET)).not.toThrow();
  });

  it('postmortem includes the hint in the title', () => {
    const out = generatePostmortem(SOURCE_ONLY_PACKET);
    expect(out).toContain('slowdown in payment-service');
  });

  it('postmortem notes no impact evidence was captured', () => {
    const out = generatePostmortem(SOURCE_ONLY_PACKET);
    expect(out).toContain('No impact evidence');
  });

  it('postmortem references the gap dimension', () => {
    const out = generatePostmortem(SOURCE_ONLY_PACKET);
    expect(out).toContain('logs');
  });

  it('postmortem has Follow-up actions section', () => {
    const out = generatePostmortem(SOURCE_ONLY_PACKET);
    expect(out).toContain('## Follow-up actions');
  });

  it('migrateReport passes source-only packet through unchanged (no suspectedCauses to migrate)', () => {
    const migrated = migrateReport(SOURCE_ONLY_PACKET);
    expect(migrated.id).toBe('compat-source-only');
    expect(migrated.confidence).toBe(0.3);
    expect(migrated.nextActions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Runtime-summary packet
// ---------------------------------------------------------------------------

describe('packet-compat — runtime-summary packet', () => {
  it('generatePostmortem does not throw on runtime-summary packet', () => {
    expect(() => generatePostmortem(RUNTIME_PACKET)).not.toThrow();
  });

  it('postmortem includes metrics gap note', () => {
    const out = generatePostmortem(RUNTIME_PACKET);
    expect(out).toContain('metrics');
  });

  it('sourceStatus is accessible after migrateReport (optional field preserved)', () => {
    const migrated = migrateReport(RUNTIME_PACKET);
    expect(migrated.sourceStatus).toBeDefined();
    expect(migrated.sourceStatus!.sources[0]?.source).toBe('logs');
    expect(migrated.sourceStatus!.sources[0]?.status).toBe('contributed');
  });

  it('sourceStatus missing does not crash generatePostmortem', () => {
    const withoutSourceStatus = { ...SOURCE_ONLY_PACKET };
    delete (withoutSourceStatus as Partial<InvestigationReport>)['sourceStatus'];
    expect(() => generatePostmortem(withoutSourceStatus as InvestigationReport)).not.toThrow();
  });

  it('postmortem lists both evidence items', () => {
    const out = generatePostmortem(RUNTIME_PACKET);
    expect(out).toContain('ev-sym');
    expect(out).toContain('ev-log');
  });
});

// ---------------------------------------------------------------------------
// 3. Change-summary packet
// ---------------------------------------------------------------------------

describe('packet-compat — change-summary packet', () => {
  it('generatePostmortem does not throw on change-summary packet', () => {
    expect(() => generatePostmortem(CHANGE_PACKET)).not.toThrow();
  });

  it('postmortem includes commit evidence in contributing factors', () => {
    const out = generatePostmortem(CHANGE_PACKET);
    expect(out).toContain('Bump gateway timeout');
  });

  it('postmortem includes nextActions as checkboxes', () => {
    const out = generatePostmortem(CHANGE_PACKET);
    expect(out).toContain('- [ ] Revert gateway timeout');
    expect(out).toContain('- [ ] Add alerting for gateway');
  });

  it('postmortem includes the suspected cause with its band', () => {
    const out = generatePostmortem(CHANGE_PACKET);
    expect(out).toContain('Gateway timeout increase caused cascading delays');
    expect(out).toContain('likely');
  });
});

// ---------------------------------------------------------------------------
// 4. Legacy compatibility — packet missing nextActions (pre-v0.1)
// ---------------------------------------------------------------------------

describe('packet-compat — legacy packet missing nextActions', () => {
  const PRE_V01_PACKET = {
    id: 'compat-pre-v01',
    input: { hint: 'crash in checkout' },
    summary: 'Checkout crashed after deploy.',
    seeds: [],
    evidence: [ev('ev-old', 'history', 'commit', 'Old commit evidence')],
    timeline: { events: [], boundaryCrossings: [] },
    correlation: { groups: [], chains: [], missing: [] },
    findings: [],
    suspectedCauses: [{ statement: 'Null pointer in checkout flow', score: 0.65, evidenceIds: [] }],
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1.0 },
    graph: { nodes: [], edges: [] },
    confidence: 0.65,
    // nextActions intentionally absent — simulates pre-v0.1 saved packet
  };

  it('migrateReport adds nextActions: [] when field is absent', () => {
    const migrated = migrateReport(PRE_V01_PACKET);
    expect(Array.isArray(migrated.nextActions)).toBe(true);
    expect(migrated.nextActions).toEqual([]);
  });

  it('generatePostmortem does not throw after migrateReport normalises the packet', () => {
    const migrated = migrateReport(PRE_V01_PACKET);
    expect(() => generatePostmortem(migrated)).not.toThrow();
  });

  it('migrateReport also migrates legacy suspectedCauses in the same pass', () => {
    const migrated = migrateReport(PRE_V01_PACKET);
    expect(migrated.suspectedCauses[0]?.title).toBe('Null pointer in checkout flow');
    expect(migrated.suspectedCauses[0]?.finalScore).toBe(0.65);
  });

  it('migrateReport is idempotent on already-normalised packets', () => {
    const once = migrateReport(PRE_V01_PACKET);
    const twice = migrateReport(once);
    expect(twice.nextActions).toEqual([]);
    expect(twice.suspectedCauses[0]?.title).toBe('Null pointer in checkout flow');
  });
});

// ---------------------------------------------------------------------------
// 5. Optional fields — ownership absent
// ---------------------------------------------------------------------------

describe('packet-compat — ownership is optional', () => {
  it('generatePostmortem does not reference ownership field (safe to omit)', () => {
    const withoutOwnership = { ...SOURCE_ONLY_PACKET, ownership: undefined };
    expect(() => generatePostmortem(withoutOwnership)).not.toThrow();
  });

  it('migrateReport preserves ownership when present', () => {
    const withOwnership = {
      ...SOURCE_ONLY_PACKET,
      ownership: {
        query: 'git log src/payment.ts',
        symbol: null,
        file: 'src/payment.ts',
        contributors: [{ author: 'Bob', commits: 10, firstDate: '2026-01-01', lastDate: '2026-06-01' }],
        likelyMaintainer: 'Bob',
        maintainerShare: 0.9,
        mostActiveRecent: 'Bob',
        confidence: 0.9,
        evidence: ['10 commits'],
        note: 'Bob is the primary maintainer.',
      },
    };
    const migrated = migrateReport(withOwnership);
    expect(migrated.ownership?.likelyMaintainer).toBe('Bob');
  });
});

// ---------------------------------------------------------------------------
// 6. Current full-packet (INCIDENT_001_FIXTURE) — regression guard
// ---------------------------------------------------------------------------

describe('packet-compat — INCIDENT_001_FIXTURE current-shape regression', () => {
  it('generatePostmortem on INCIDENT_001_FIXTURE does not throw', () => {
    expect(() => generatePostmortem(INCIDENT_001_FIXTURE)).not.toThrow();
  });

  it('migrateReport on INCIDENT_001_FIXTURE is idempotent', () => {
    const migrated = migrateReport(INCIDENT_001_FIXTURE);
    expect(migrated.id).toBe(INCIDENT_001_FIXTURE.id);
    expect(migrated.suspectedCauses[0]?.title).toBe(INCIDENT_001_FIXTURE.suspectedCauses[0]?.title);
    expect(migrated.nextActions).toEqual(INCIDENT_001_FIXTURE.nextActions);
  });

  it('postmortem from INCIDENT_001_FIXTURE mentions the incident hint', () => {
    const out = generatePostmortem(INCIDENT_001_FIXTURE);
    expect(out).toContain('BullMQ workers stalling');
  });

  it('postmortem from INCIDENT_001_FIXTURE includes the suspected cause', () => {
    const out = generatePostmortem(INCIDENT_001_FIXTURE);
    expect(out).toContain('Redis connection pool exhausted');
  });

  it('postmortem from INCIDENT_001_FIXTURE includes the state gap note', () => {
    const out = generatePostmortem(INCIDENT_001_FIXTURE);
    expect(out).toContain('state');
  });
});
