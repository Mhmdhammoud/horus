/**
 * HOR-19 — Unit tests for detectMissingEvidence (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { InvestigationReport } from './types.js';
import { detectMissingEvidence } from './gaps.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(
  kind: Evidence['kind'],
  extraLinks: Evidence['links'] = {},
): Evidence {
  return {
    id: globalThis.crypto.randomUUID(),
    source:
      kind === 'commit'
        ? 'history'
        : kind === 'queue-edge' || kind === 'queue-state'
          ? 'queue'
          : kind === 'log'
            ? 'logs'
            : kind === 'metric'
              ? 'metrics'
              : 'code',
    kind,
    title: `Test evidence (${kind})`,
    relevance: 0.5,
    payload: {},
    links: extraLinks,
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };
}

function makeMinimalReport(overrides: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    id: 'test-id',
    input: { hint: 'test' },
    summary: 'test summary',
    seeds: [],
    evidence: [],
    timeline: { events: [], boundaryCrossings: [] },
    correlation: { groups: [], chains: [], missing: [] },
    findings: [],
    suspectedCauses: [],
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
    graph: { nodes: [], edges: [] },
    confidence: 0.5,
    nextActions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) Report with a queue boundary crossing but no queue-state/metric/log/commit
// ---------------------------------------------------------------------------

describe('detectMissingEvidence', () => {
  it('(a) queue topology + no operational evidence → many gaps, ceiling < 1 and >= 0.3', () => {
    const report = makeMinimalReport({
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'email-queue', producer: 'sendEmail', worker: 'emailWorker', evidenceId: 'ev-001' },
        ],
      },
      evidence: [],
    });

    const result = detectMissingEvidence(report);

    // Must include these gap dimensions
    const dims = result.gaps.map((g) => g.dimension);
    expect(dims).toContain('queue runtime state');
    expect(dims).toContain('metrics');
    expect(dims).toContain('logs');
    expect(dims).toContain('deployment records');
    expect(dims).toContain('ownership');

    // Ceiling is less than 1 (some gaps) and at least the floor of 0.3
    expect(result.confidenceCeiling).toBeLessThan(1);
    expect(result.confidenceCeiling).toBeGreaterThanOrEqual(0.3);

    // Blind spots list is non-empty
    expect(result.blindSpots.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // (b) Report WITH a commit evidence → no 'deployment records' gap
  // -------------------------------------------------------------------------

  it('(b) commit evidence present → no deployment records gap', () => {
    const report = makeMinimalReport({
      evidence: [makeEvidence('commit')],
    });

    const result = detectMissingEvidence(report);

    const dims = result.gaps.map((g) => g.dimension);
    expect(dims).not.toContain('deployment records');
  });

  // -------------------------------------------------------------------------
  // (c) Rich evidence set → only ownership and traces remain
  // -------------------------------------------------------------------------

  it('(c) log+metric+queue-state+commit+traceId → only ownership and traces gaps, high ceiling', () => {
    const report = makeMinimalReport({
      evidence: [
        makeEvidence('log'),
        makeEvidence('metric'),
        makeEvidence('queue-state'),
        makeEvidence('commit'),
        // trace is detected via links.traceId
        makeEvidence('symbol', { traceId: 'trace-abc-123' }),
      ],
    });

    const result = detectMissingEvidence(report);

    const dims = result.gaps.map((g) => g.dimension);

    // These should NOT be gaps
    expect(dims).not.toContain('logs');
    expect(dims).not.toContain('metrics');
    expect(dims).not.toContain('queue runtime state');
    expect(dims).not.toContain('deployment records');
    expect(dims).not.toContain('traces');

    // Ownership is always unknown until HOR-20
    expect(dims).toContain('ownership');

    // Ceiling should be high (only 0.05 deducted for ownership)
    expect(result.confidenceCeiling).toBeGreaterThanOrEqual(0.9);

    // Indexed access guard: verify gap objects are present
    const ownershipGap = result.gaps.find((g) => g.dimension === 'ownership');
    expect(ownershipGap).toBeDefined();
    if (ownershipGap !== undefined) {
      expect(ownershipGap.confidenceImpact).toBe(0.05);
    }
  });

  // -------------------------------------------------------------------------
  // Additional: gap text reflects configured connectors, not ticket names
  // -------------------------------------------------------------------------

  it('metrics gap points at `horus metrics` when Grafana is configured', () => {
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, { grafana: true });
    const metricsGap = result.gaps.find((g) => g.dimension === 'metrics');
    expect(metricsGap?.nextSource).toContain('horus metrics');
    expect(metricsGap?.nextSource).not.toContain('HOR-');
  });

  it('logs gap distinguishes configured-but-empty from not-configured', () => {
    const report = makeMinimalReport({ evidence: [] });
    // logsCollected:true = collection ran successfully, just no error logs in window
    const configured = detectMissingEvidence(report, {
      elasticsearch: true,
      logsCollected: true,
    }).gaps.find((g) => g.dimension === 'logs');
    const notConfigured = detectMissingEvidence(report, { elasticsearch: false })
      .gaps.find((g) => g.dimension === 'logs');
    expect(configured?.why).toContain('No error logs matched');
    expect(notConfigured?.why).toContain('No Elasticsearch connector');
    expect(configured?.nextSource).not.toContain('HOR-');
  });

  it('logs gap reflects collection failure when logsCollected is false', () => {
    const report = makeMinimalReport({ evidence: [] });
    const gap = detectMissingEvidence(report, { elasticsearch: true, logsCollected: false })
      .gaps.find((g) => g.dimension === 'logs');
    expect(gap?.why).toContain('failed');
  });

  it('logs gap reflects mapping incompatibility when logsCompatibilityError is set', () => {
    const report = makeMinimalReport({ evidence: [] });
    const gap = detectMissingEvidence(report, {
      elasticsearch: true,
      logsCompatibilityError: "Timestamp field 'time' not found",
    }).gaps.find((g) => g.dimension === 'logs');
    expect(gap?.why).toContain('incompatible');
    expect(gap?.why).toContain("'time'");
    expect(gap?.nextSource).toContain('preset');
  });

  // -------------------------------------------------------------------------
  // Additional: confidenceCeiling floor is 0.3 even when all gaps present
  // -------------------------------------------------------------------------

  it('confidenceCeiling never falls below 0.3', () => {
    const report = makeMinimalReport({
      evidence: [],
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'q', producer: 'p', worker: 'w', evidenceId: 'ev-003' },
        ],
      },
    });
    const result = detectMissingEvidence(report);
    expect(result.confidenceCeiling).toBeGreaterThanOrEqual(0.3);
  });
});
