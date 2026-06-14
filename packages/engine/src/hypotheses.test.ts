/**
 * HOR-24 — Unit tests for generateHypotheses (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { CorrelationResult } from './correlate.js';
import { generateHypotheses } from './hypotheses.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(kind: Evidence['kind'], id?: string): Evidence {
  return {
    id: id ?? globalThis.crypto.randomUUID(),
    source: kind === 'commit' ? 'history' : kind === 'queue-edge' ? 'queue' : 'code',
    kind,
    title: `Test evidence (${kind})`,
    relevance: 0.5,
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };
}

const emptyCorrelation: CorrelationResult = {
  groups: [],
  chains: [],
  missing: [],
};

// ---------------------------------------------------------------------------
// Main tests
// ---------------------------------------------------------------------------

describe('generateHypotheses', () => {
  it('returns at least 6 hypotheses when both queue-edge and commit evidence are present', () => {
    const commitEv = makeEvidence('commit');
    const queueEv = makeEvidence('queue-edge');
    const evidence: Evidence[] = [commitEv, queueEv];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    expect(hyps.length).toBeGreaterThanOrEqual(6);
  });

  it('covers all required categories', () => {
    const evidence: Evidence[] = [makeEvidence('commit'), makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    const categories = new Set(hyps.map((h) => h.category));
    expect(categories.has('deployment-regression')).toBe(true);
    expect(categories.has('queue-backlog')).toBe(true);
    expect(categories.has('worker-slowdown')).toBe(true);
    expect(categories.has('external-api-latency')).toBe(true);
    expect(categories.has('retry-storm')).toBe(true);
    expect(categories.has('infrastructure')).toBe(true);
  });

  it('deployment-regression includes the commit evidence id and has confidence 0.5 when commit exists', () => {
    const commitId = globalThis.crypto.randomUUID();
    const commitEv = makeEvidence('commit', commitId);
    const queueEv = makeEvidence('queue-edge');
    const evidence: Evidence[] = [commitEv, queueEv];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    const dr = hyps.find((h) => h.category === 'deployment-regression');
    expect(dr).toBeDefined();
    expect(dr!.supportingEvidenceIds).toContain(commitId);
    expect(dr!.confidence).toBe(0.5);
  });

  it('every hypothesis has a non-empty statement and confidence in [0, 1]', () => {
    const evidence: Evidence[] = [makeEvidence('commit'), makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    for (const h of hyps) {
      expect(h.statement.length).toBeGreaterThan(0);
      expect(h.confidence).toBeGreaterThanOrEqual(0);
      expect(h.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('hypotheses are sorted by confidence descending', () => {
    const evidence: Evidence[] = [makeEvidence('commit'), makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    for (let i = 0; i < hyps.length - 1; i++) {
      const a = hyps[i];
      const b = hyps[i + 1];
      // Guard noUncheckedIndexedAccess
      if (a !== undefined && b !== undefined) {
        expect(a.confidence).toBeGreaterThanOrEqual(b.confidence);
      }
    }
  });

  it('no-commit case: deployment-regression confidence is 0.15 and missingEvidence is non-empty', () => {
    // Only a queue-edge, no commit
    const evidence: Evidence[] = [makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    const dr = hyps.find((h) => h.category === 'deployment-regression');
    expect(dr).toBeDefined();
    expect(dr!.confidence).toBe(0.15);
    expect(dr!.missingEvidence.length).toBeGreaterThan(0);
  });

  it('queue-backlog and worker-slowdown are absent when no queue-edge evidence is provided', () => {
    const evidence: Evidence[] = [makeEvidence('commit')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
    });

    const categories = hyps.map((h) => h.category);
    expect(categories).not.toContain('queue-backlog');
    expect(categories).not.toContain('worker-slowdown');
  });

  it('returns at least 4 hypotheses even with no queue evidence (always-emitted ones)', () => {
    const evidence: Evidence[] = [makeEvidence('symbol')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'Y',
      queues: [],
    });

    // deployment-regression, external-api-latency, retry-storm, infrastructure
    expect(hyps.length).toBeGreaterThanOrEqual(4);
  });
});
