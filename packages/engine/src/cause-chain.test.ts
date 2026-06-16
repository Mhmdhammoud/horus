/**
 * HOR-196 — Unit tests for cause-chain construction.
 * Pure unit tests — no I/O, no git, no DB.
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { ValidatedHypothesis } from './validate.js';
import type { InvestigationGraph } from './graph.js';
import { buildCauseChains } from './cause-chain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_GRAPH: InvestigationGraph = { nodes: [], edges: [] };

function makeHyp(
  overrides: Partial<ValidatedHypothesis> & Pick<ValidatedHypothesis, 'category' | 'verdict'>,
): ValidatedHypothesis {
  return {
    id: 'hyp-' + overrides.category,
    statement: 'A test hypothesis for ' + overrides.category + '.',
    confidence: 0.6,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    priorConfidence: 0.5,
    supportingPresent: 0,
    contradictingPresent: 0,
    rationale: 'test',
    ...overrides,
  };
}

function makeEv(id: string, kind: string, title?: string): Evidence {
  return {
    id,
    source: 'code' as const,
    kind: kind as Evidence['kind'],
    title: title ?? `${kind} evidence ${id}`,
    relevance: 0.8,
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: '2026-06-16T00:00:00Z' },
  };
}

// ---------------------------------------------------------------------------
// buildCauseChains — filtering
// ---------------------------------------------------------------------------

describe('buildCauseChains — filtering', () => {
  it('returns an empty array when no hypotheses are supported or weakened', () => {
    const hyps = [
      makeHyp({ category: 'deployment-regression', verdict: 'unconfirmed' }),
      makeHyp({ category: 'queue-backlog', verdict: 'eliminated' }),
    ];
    const chains = buildCauseChains(hyps, [], EMPTY_GRAPH, 'MyService');
    expect(chains).toHaveLength(0);
  });

  it('builds a chain for supported hypotheses', () => {
    const hyp = makeHyp({ category: 'deployment-regression', verdict: 'supported' });
    const chains = buildCauseChains([hyp], [], EMPTY_GRAPH, 'MyService');
    expect(chains).toHaveLength(1);
    expect(chains[0]?.hypothesisId).toBe('hyp-deployment-regression');
  });

  it('builds a chain for weakened hypotheses', () => {
    const hyp = makeHyp({ category: 'queue-backlog', verdict: 'weakened' });
    const chains = buildCauseChains([hyp], [], EMPTY_GRAPH, 'MyService');
    expect(chains).toHaveLength(1);
  });

  it('skips unconfirmed and eliminated, builds chain for supported', () => {
    const hyps = [
      makeHyp({ category: 'deployment-regression', verdict: 'supported' }),
      makeHyp({ category: 'queue-backlog', verdict: 'unconfirmed' }),
      makeHyp({ category: 'infrastructure', verdict: 'eliminated' }),
    ];
    const chains = buildCauseChains(hyps, [], EMPTY_GRAPH, 'MyService');
    expect(chains).toHaveLength(1);
    expect(chains[0]?.category).toBe('deployment-regression');
  });
});

// ---------------------------------------------------------------------------
// buildCauseChains — deployment-regression
// ---------------------------------------------------------------------------

describe('buildCauseChains — deployment-regression', () => {
  it('first step is trigger with commit evidence', () => {
    const commitEv = makeEv('ev-commit-1', 'commit', 'Change in HEAD~5..HEAD: +3 -1 symbols');
    const hyp = makeHyp({
      category: 'deployment-regression',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-commit-1'],
    });
    const chains = buildCauseChains([hyp], [commitEv], EMPTY_GRAPH, 'OrderService');
    const chain = chains[0]!;
    const trigger = chain.steps.find((s) => s.role === 'trigger');
    expect(trigger).toBeDefined();
    expect(trigger!.evidenceIds).toContain('ev-commit-1');
  });

  it('includes propagation step with symbol evidence', () => {
    const commitEv = makeEv('ev-commit', 'commit');
    const symbolEv = makeEv('ev-symbol', 'symbol', 'Seed symbol OrderService');
    const hyp = makeHyp({
      category: 'deployment-regression',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-commit', 'ev-symbol'],
    });
    const chains = buildCauseChains([hyp], [commitEv, symbolEv], EMPTY_GRAPH, 'OrderService');
    const chain = chains[0]!;
    const propagation = chain.steps.find((s) => s.role === 'propagation');
    expect(propagation).toBeDefined();
    expect(propagation!.label).toContain('OrderService');
  });

  it('includes symptom step when log evidence is present in supporting IDs', () => {
    const commitEv = makeEv('ev-commit', 'commit');
    const logEv = makeEv('ev-log', 'log', 'Error AUTH_FAIL 42x');
    const hyp = makeHyp({
      category: 'deployment-regression',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-commit', 'ev-log'],
    });
    const chains = buildCauseChains([hyp], [commitEv, logEv], EMPTY_GRAPH, 'OrderService');
    const chain = chains[0]!;
    const symptom = chain.steps.find((s) => s.role === 'symptom');
    expect(symptom).toBeDefined();
    expect(symptom!.evidenceIds).toContain('ev-log');
  });

  it('summary mentions the seed label', () => {
    const hyp = makeHyp({ category: 'deployment-regression', verdict: 'supported' });
    const chains = buildCauseChains([hyp], [], EMPTY_GRAPH, 'PaymentProcessor');
    expect(chains[0]?.summary).toContain('PaymentProcessor');
  });

  it('chain confidence matches hypothesis confidence', () => {
    const hyp = makeHyp({
      category: 'deployment-regression',
      verdict: 'supported',
      confidence: 0.72,
    });
    const chains = buildCauseChains([hyp], [], EMPTY_GRAPH, 'MyService');
    expect(chains[0]?.confidence).toBe(0.72);
  });
});

// ---------------------------------------------------------------------------
// buildCauseChains — queue-backlog
// ---------------------------------------------------------------------------

describe('buildCauseChains — queue-backlog', () => {
  it('trigger step references the queue name from hypothesis statement', () => {
    const queueEdgeEv = makeEv('ev-qedge', 'queue-edge', 'Queue "payments": OrderService -> PaymentWorker');
    const hyp = makeHyp({
      category: 'queue-backlog',
      verdict: 'supported',
      statement: 'A backlog on payments — producers enqueue faster than the worker drains.',
      supportingEvidenceIds: ['ev-qedge'],
    });
    const chains = buildCauseChains([hyp], [queueEdgeEv], EMPTY_GRAPH, 'OrderService');
    const chain = chains[0]!;
    const trigger = chain.steps.find((s) => s.role === 'trigger');
    expect(trigger?.label).toContain('payments');
  });

  it('propagation step has queue-state evidence', () => {
    const queueStateEv = makeEv('ev-qstate', 'queue-state', 'payments: 500 waiting, 0 active');
    const hyp = makeHyp({
      category: 'queue-backlog',
      verdict: 'supported',
      statement: 'A backlog on payments.',
      supportingEvidenceIds: ['ev-qstate'],
    });
    const chains = buildCauseChains([hyp], [queueStateEv], EMPTY_GRAPH, 'OrderService');
    const chain = chains[0]!;
    const propagation = chain.steps.find((s) => s.role === 'propagation');
    expect(propagation).toBeDefined();
    expect(propagation!.evidenceIds).toContain('ev-qstate');
  });

  it('summary describes queue backlog pattern', () => {
    const hyp = makeHyp({
      category: 'queue-backlog',
      verdict: 'supported',
      statement: 'A backlog on orders.',
    });
    const chains = buildCauseChains([hyp], [], EMPTY_GRAPH, 'OrderService');
    expect(chains[0]?.summary).toContain('backed up');
  });
});

// ---------------------------------------------------------------------------
// buildCauseChains — external-api-latency
// ---------------------------------------------------------------------------

describe('buildCauseChains — external-api-latency', () => {
  it('trigger step has metric evidence', () => {
    const metricEv = makeEv('ev-metric', 'metric', 'LATENCY-SPIKE: HTTP p95 Latency 0.05 -> 2.30 (x46.00)');
    const hyp = makeHyp({
      category: 'external-api-latency',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-metric'],
    });
    const chains = buildCauseChains([hyp], [metricEv], EMPTY_GRAPH, 'MyService');
    const chain = chains[0]!;
    const trigger = chain.steps.find((s) => s.role === 'trigger');
    expect(trigger?.evidenceIds).toContain('ev-metric');
    expect(trigger?.label).toContain('latency spike');
  });

  it('propagation step has log evidence when present', () => {
    const metricEv = makeEv('ev-metric', 'metric');
    const logEv = makeEv('ev-log', 'log', 'Error TIMEOUT 100x');
    const hyp = makeHyp({
      category: 'external-api-latency',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-metric', 'ev-log'],
    });
    const chains = buildCauseChains([hyp], [metricEv, logEv], EMPTY_GRAPH, 'MyService');
    const chain = chains[0]!;
    const propagation = chain.steps.find((s) => s.role === 'propagation');
    expect(propagation?.evidenceIds).toContain('ev-log');
  });
});

// ---------------------------------------------------------------------------
// buildCauseChains — infrastructure
// ---------------------------------------------------------------------------

describe('buildCauseChains — infrastructure', () => {
  it('trigger step has state evidence', () => {
    const stateEv = makeEv('ev-state', 'state', 'orders collection: 12 failed');
    const hyp = makeHyp({
      category: 'infrastructure',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-state'],
    });
    const chains = buildCauseChains([hyp], [stateEv], EMPTY_GRAPH, 'MyService');
    const chain = chains[0]!;
    const trigger = chain.steps.find((s) => s.role === 'trigger');
    expect(trigger?.evidenceIds).toContain('ev-state');
    expect(trigger?.label).toContain('Infrastructure');
  });
});

// ---------------------------------------------------------------------------
// buildCauseChains — retry-storm
// ---------------------------------------------------------------------------

describe('buildCauseChains — retry-storm', () => {
  it('trigger step has log spike evidence', () => {
    const logEv = makeEv('ev-log-spike', 'log', 'Error DB_TIMEOUT 300x spike x4.5');
    const hyp = makeHyp({
      category: 'retry-storm',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-log-spike'],
    });
    const chains = buildCauseChains([hyp], [logEv], EMPTY_GRAPH, 'MyService');
    const chain = chains[0]!;
    const trigger = chain.steps.find((s) => s.role === 'trigger');
    expect(trigger?.evidenceIds).toContain('ev-log-spike');
    expect(trigger?.label).toContain('retry');
  });
});

// ---------------------------------------------------------------------------
// buildCauseChains — generic fallback
// ---------------------------------------------------------------------------

describe('buildCauseChains — generic fallback', () => {
  it('produces at least a trigger step for unknown category', () => {
    const hyp = makeHyp({ category: 'unknown-category', verdict: 'supported' });
    const chains = buildCauseChains([hyp], [], EMPTY_GRAPH, 'MyService');
    expect(chains).toHaveLength(1);
    const chain = chains[0]!;
    expect(chain.steps.length).toBeGreaterThan(0);
    expect(chain.steps[0]?.role).toBe('trigger');
  });
});

// ---------------------------------------------------------------------------
// buildCauseChains — evidence citation
// ---------------------------------------------------------------------------

describe('buildCauseChains — evidence citation', () => {
  it('all evidence IDs in chain steps are from the provided evidence array', () => {
    const commitEv = makeEv('ev-c1', 'commit');
    const logEv = makeEv('ev-l1', 'log');
    const hyp = makeHyp({
      category: 'deployment-regression',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-c1', 'ev-l1'],
    });
    const chains = buildCauseChains([hyp], [commitEv, logEv], EMPTY_GRAPH, 'Seed');
    const allCitedIds = chains.flatMap((c) => c.steps.flatMap((s) => s.evidenceIds));
    const knownIds = new Set(['ev-c1', 'ev-l1']);
    for (const id of allCitedIds) {
      expect(knownIds.has(id)).toBe(true);
    }
  });

  it('does not cite evidence IDs absent from the evidence array', () => {
    const hyp = makeHyp({
      category: 'deployment-regression',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-ghost'], // not in evidence array
    });
    const chains = buildCauseChains([hyp], [], EMPTY_GRAPH, 'Seed');
    // chain is built but ghost ID is not in any step since evById lookup fails
    const cited = chains.flatMap((c) => c.steps.flatMap((s) => s.evidenceIds));
    expect(cited).not.toContain('ev-ghost');
  });
});

// ---------------------------------------------------------------------------
// buildCauseChains — graph node references
// ---------------------------------------------------------------------------

describe('buildCauseChains — graph node references', () => {
  it('trigger step graphNodeId points to an implicated deployment node', () => {
    const commitEv = makeEv('ev-c', 'commit');
    const graph: InvestigationGraph = {
      nodes: [
        { id: 'deployment:ev-c', type: 'deployment', label: 'commit', evidenceIds: ['ev-c'], implicated: true, implicationScore: 0.8 },
      ],
      edges: [],
    };
    const hyp = makeHyp({
      category: 'deployment-regression',
      verdict: 'supported',
      supportingEvidenceIds: ['ev-c'],
    });
    const chains = buildCauseChains([hyp], [commitEv], graph, 'Seed');
    const trigger = chains[0]?.steps.find((s) => s.role === 'trigger');
    expect(trigger?.graphNodeId).toBe('deployment:ev-c');
  });
});
