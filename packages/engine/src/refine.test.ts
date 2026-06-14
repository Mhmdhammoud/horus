/**
 * HOR-21 — Unit tests for refineInvestigation (pure, no I/O, no AI).
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { InvestigationReport } from './types.js';
import type { ValidatedHypothesis } from './validate.js';
import { refineInvestigation } from './refine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(kind: Evidence['kind'], id?: string): Evidence {
  return {
    id: id ?? globalThis.crypto.randomUUID(),
    source:
      kind === 'commit'
        ? 'history'
        : kind === 'queue-edge'
          ? 'queue'
          : kind === 'symbol'
            ? 'code'
            : 'logs',
    kind,
    title: 'Test evidence (' + kind + ')',
    relevance: 0.5,
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };
}

function makeHypothesis(
  category: ValidatedHypothesis['category'],
  statement?: string,
): ValidatedHypothesis {
  return {
    id: globalThis.crypto.randomUUID(),
    category,
    statement: statement ?? 'Hypothesis about ' + category,
    confidence: 0.5,
    priorConfidence: 0.4,
    verdict: 'unconfirmed',
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    supportingPresent: 0,
    contradictingPresent: 0,
    rationale: '0 supporting / 0 contradicting evidence present.',
  };
}

// ---------------------------------------------------------------------------
// Fixture: a minimal but complete InvestigationReport with all 6 categories
// ---------------------------------------------------------------------------

const queueEdgeEv = makeEvidence('queue-edge', 'ev-queue-01');
const commitEv = makeEvidence('commit', 'ev-commit-01');
const symbolEv = makeEvidence('symbol', 'ev-symbol-01');

const REPORT: InvestigationReport = {
  id: 'inv-test-001',
  input: { hint: 'order-processor latency spike' },
  summary: 'Test investigation summary.',
  seeds: [],
  evidence: [queueEdgeEv, commitEv, symbolEv],
  timeline: { events: [], boundaryCrossings: [] },
  correlation: { groups: [], chains: [], missing: [] },
  findings: [],
  suspectedCauses: [
    {
      statement: 'A queue backlog caused delayed processing.',
      score: 0.8,
      evidenceIds: [queueEdgeEv.id],
    },
    {
      statement: 'A deployment regression introduced the fault.',
      score: 0.6,
      evidenceIds: [commitEv.id],
    },
  ],
  hypotheses: [
    makeHypothesis('queue-backlog'),
    makeHypothesis('worker-slowdown'),
    makeHypothesis('deployment-regression'),
    makeHypothesis('external-api-latency'),
    makeHypothesis('retry-storm'),
    makeHypothesis('infrastructure'),
  ],
  similarIncidents: [],
  gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 0.9 },
  confidence: 0.45,
  nextActions: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('refineInvestigation', () => {
  // ── focus on queue ─────────────────────────────────────────────────────────
  it('mode is "focus" when directive contains "focus on queue behavior"', () => {
    const v = refineInvestigation(REPORT, 'focus on queue behavior');
    expect(v.mode).toBe('focus');
  });

  it('topics include "queue" for "focus on queue behavior"', () => {
    const v = refineInvestigation(REPORT, 'focus on queue behavior');
    expect(v.topics).toContain('queue');
  });

  it('focus on queue: hypotheses contain only queue-backlog and worker-slowdown', () => {
    const v = refineInvestigation(REPORT, 'focus on queue behavior');
    const categories = v.hypotheses.map((h) => h.category);
    expect(categories).toContain('queue-backlog');
    // worker maps to same kind (queue-edge) but "queue behavior" does not
    // explicitly mention worker; however "queue" topic does NOT match worker category.
    // Only the "queue" topic is matched → only queue-backlog is included.
    for (const cat of categories) {
      expect(['queue-backlog', 'worker-slowdown']).toContain(cat);
    }
    expect(categories).not.toContain('deployment-regression');
    expect(categories).not.toContain('external-api-latency');
    expect(categories).not.toContain('retry-storm');
    expect(categories).not.toContain('infrastructure');
  });

  it('focus on queue: evidence includes queue-edge and symbol (seed context) but not commit', () => {
    const v = refineInvestigation(REPORT, 'focus on queue behavior');
    const kinds = v.evidence.map((e) => e.kind);
    expect(kinds).toContain('queue-edge');
    expect(kinds).toContain('symbol'); // seed context always kept
    expect(kinds).not.toContain('commit');
  });

  it('focus on queue: suspected causes referencing queue keyword are retained', () => {
    const v = refineInvestigation(REPORT, 'focus on queue behavior');
    // The first cause mentions "queue", second does not — at least one kept
    expect(v.suspectedCauses.length).toBeGreaterThan(0);
    const hasQueueCause = v.suspectedCauses.some((c) =>
      c.statement.toLowerCase().includes('queue'),
    );
    expect(hasQueueCause).toBe(true);
  });

  // ── ignore deployment ──────────────────────────────────────────────────────
  it('mode is "ignore" when directive contains "ignore deployment changes"', () => {
    const v = refineInvestigation(REPORT, 'ignore deployment changes');
    expect(v.mode).toBe('ignore');
  });

  it('ignore deployment: deployment-regression hypothesis is removed', () => {
    const v = refineInvestigation(REPORT, 'ignore deployment changes');
    const categories = v.hypotheses.map((h) => h.category);
    expect(categories).not.toContain('deployment-regression');
  });

  it('ignore deployment: commit evidence is removed', () => {
    const v = refineInvestigation(REPORT, 'ignore deployment changes');
    const kinds = v.evidence.map((e) => e.kind);
    expect(kinds).not.toContain('commit');
  });

  it('ignore deployment: all other hypotheses are retained', () => {
    const v = refineInvestigation(REPORT, 'ignore deployment changes');
    const categories = v.hypotheses.map((h) => h.category);
    expect(categories).toContain('queue-backlog');
    expect(categories).toContain('worker-slowdown');
    expect(categories).toContain('external-api-latency');
    expect(categories).toContain('retry-storm');
    expect(categories).toContain('infrastructure');
  });

  // ── unrecognized directive → mode 'none' ───────────────────────────────────
  it('mode is "none" for an unrecognized directive', () => {
    const v = refineInvestigation(REPORT, 'what is the meaning of life');
    expect(v.mode).toBe('none');
  });

  it('mode none: all hypotheses are returned', () => {
    const v = refineInvestigation(REPORT, 'what is the meaning of life');
    expect(v.hypotheses.length).toBe(REPORT.hypotheses.length);
  });

  it('mode none: all evidence is returned', () => {
    const v = refineInvestigation(REPORT, 'what is the meaning of life');
    expect(v.evidence.length).toBe(REPORT.evidence.length);
  });

  it('mode none: note contains recognized topic names', () => {
    const v = refineInvestigation(REPORT, 'what is the meaning of life');
    expect(v.note).toContain('queue');
    expect(v.note).toContain('worker');
    expect(v.note).toContain('deployment');
  });

  // ── note content ───────────────────────────────────────────────────────────
  it('focus note mentions "no re-query of production"', () => {
    const v = refineInvestigation(REPORT, 'focus on queue behavior');
    expect(v.note).toMatch(/no re-query of production/i);
  });

  it('ignore note mentions "no re-query of production"', () => {
    const v = refineInvestigation(REPORT, 'ignore deployment changes');
    expect(v.note).toMatch(/no re-query of production/i);
  });

  // ── directive is preserved verbatim ───────────────────────────────────────
  it('directive field matches the input string exactly', () => {
    const directive = 'Focus on Queue Behavior';
    const v = refineInvestigation(REPORT, directive);
    expect(v.directive).toBe(directive);
  });
});
