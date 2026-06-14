/**
 * HOR-24 — Unit tests for generateHypotheses (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { CorrelationResult } from './correlate.js';
import { generateHypotheses } from './hypotheses.js';
import { validateHypotheses } from './validate.js';

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

  // ── Verdict correctness (HOR-45) ───────────────────────────────────────────

  it('queue-backlog has empty supportingEvidenceIds — structural queue-edge evidence is not runtime confirmation', () => {
    const queueEv = makeEvidence('queue-edge');
    const hyps = generateHypotheses([queueEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });
    const qb = hyps.find((h) => h.category === 'queue-backlog');
    expect(qb).toBeDefined();
    expect(qb!.supportingEvidenceIds).toHaveLength(0);
  });

  it('queue-backlog verdict is unconfirmed when only structural evidence is present', () => {
    const queueEv = makeEvidence('queue-edge');
    const hyps = generateHypotheses([queueEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });
    const validated = validateHypotheses(hyps, [queueEv]);
    const qb = validated.find((h) => h.category === 'queue-backlog');
    expect(qb?.verdict).toBe('unconfirmed');
  });

  it('worker-slowdown supportingEvidenceIds contains only metric IDs, not queue-edge IDs', () => {
    const queueEv = makeEvidence('queue-edge');
    const metricId = globalThis.crypto.randomUUID();
    const hyps = generateHypotheses([queueEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
      queueMetricEvIds: [metricId],
    });
    const ws = hyps.find((h) => h.category === 'worker-slowdown');
    expect(ws).toBeDefined();
    expect(ws!.supportingEvidenceIds).toContain(metricId);
    expect(ws!.supportingEvidenceIds).not.toContain(queueEv.id);
  });

  it('worker-slowdown verdict is unconfirmed without metric evidence, supported with it', () => {
    const queueEv = makeEvidence('queue-edge');

    // Without metric evidence → unconfirmed
    const hypsNoMetrics = generateHypotheses([queueEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });
    const validatedNoMetrics = validateHypotheses(hypsNoMetrics, [queueEv]);
    const wsNoMetrics = validatedNoMetrics.find((h) => h.category === 'worker-slowdown');
    expect(wsNoMetrics?.verdict).toBe('unconfirmed');

    // With metric evidence → supported
    const metricId = globalThis.crypto.randomUUID();
    const metricEv: Evidence = {
      id: metricId,
      source: 'metrics',
      kind: 'metric',
      title: 'Queue growth spike',
      relevance: 0.8,
      payload: {},
      links: {},
      provenance: { query: 'test', collectedAt: new Date().toISOString() },
    };
    const hypsWithMetrics = generateHypotheses([queueEv, metricEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
      queueMetricEvIds: [metricId],
    });
    const validatedWithMetrics = validateHypotheses(hypsWithMetrics, [queueEv, metricEv]);
    const wsWithMetrics = validatedWithMetrics.find((h) => h.category === 'worker-slowdown');
    expect(wsWithMetrics?.verdict).toBe('supported');
  });
});
