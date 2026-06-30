/**
 * HOR-15 — Unit tests for score-cause.ts (pure, no I/O, no AI).
 *
 * 8 scenarios covering each scoring factor individually, then combined.
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { InvestigationGraph } from './graph.js';
import type {
  CauseCandidate,
  CauseInput,
  ScoringContext,
  ScoringFinding,
  ScoringRequest,
} from './score-cause.js';
import { scoreCause, rankCauses, selectHeadlineCause } from './score-cause.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_GRAPH: InvestigationGraph = { nodes: [], edges: [] };

const FIXED_NOW = '2026-06-14T20:00:00.000Z';

function makeEvidence(
  id: string,
  kind: Evidence['kind'],
  source: Evidence['source'],
  relevance: number,
  priority?: Evidence['priority'],
  extra?: Partial<Evidence>,
): Evidence {
  return {
    id,
    source,
    kind,
    title: `Evidence ${id}`,
    relevance,
    payload: extra?.payload ?? {},
    links: {},
    provenance: { query: 'test', collectedAt: FIXED_NOW },
    priority,
    ...extra,
  };
}

function makeInput(
  overrides: Partial<CauseInput> = {},
): CauseInput {
  return {
    id: 'cause:test',
    title: 'Test cause',
    category: 'other',
    sourceEvidenceIds: [],
    baseScore: 0.40,
    ...overrides,
  };
}

function makeCtx(
  evidence: Evidence[],
  graph: InvestigationGraph = EMPTY_GRAPH,
): ScoringContext {
  return { evidence, graph, now: FIXED_NOW };
}

// ---------------------------------------------------------------------------
// Scenario 1: No evidence attached
// ---------------------------------------------------------------------------

describe('scoreCause — incident-history factor (HOR-363)', () => {
  const symGraph: InvestigationGraph = {
    nodes: [
      {
        id: 'symbol:authenticateToken',
        type: 'symbol',
        label: 'authenticateToken',
        evidenceIds: ['ev-sym'],
        implicated: false,
        implicationScore: 0,
      },
    ],
    edges: [],
  };
  const symEvidence = [makeEvidence('ev-sym', 'symbol', 'code', 0.8)];
  const input = makeInput({ baseScore: 0.4, sourceEvidenceIds: ['ev-sym'] });

  it('boosts a cause whose code has a prior-incident history', () => {
    const ctx: ScoringContext = {
      evidence: symEvidence,
      graph: symGraph,
      now: FIXED_NOW,
      priorIncidents: new Map([['symbol:authenticateToken', 2]]),
    };
    const result = scoreCause(input, ctx);
    const f = result.explanations.find((e) => e.factor === 'incident-history');
    expect(f).toBeDefined();
    expect(f!.delta).toBeGreaterThan(0);
    expect(f!.reason).toContain('authenticateToken');
    expect(f!.reason).toContain('2 prior investigation');
  });

  it('does not fire without priorIncidents', () => {
    const result = scoreCause(input, { evidence: symEvidence, graph: symGraph, now: FIXED_NOW });
    expect(result.explanations.some((e) => e.factor === 'incident-history')).toBe(false);
  });

  it('does not fire when the cause code is not in prior incidents', () => {
    const ctx: ScoringContext = {
      evidence: symEvidence,
      graph: symGraph,
      now: FIXED_NOW,
      priorIncidents: new Map([['symbol:unrelated', 3]]),
    };
    expect(scoreCause(input, ctx).explanations.some((e) => e.factor === 'incident-history')).toBe(
      false,
    );
  });

  it('caps the boost at +0.10 for many matched nodes', () => {
    const manyNodes: InvestigationGraph = {
      nodes: Array.from({ length: 5 }, (_, i) => ({
        id: `symbol:s${i}`,
        type: 'symbol' as const,
        label: `s${i}`,
        evidenceIds: ['ev-sym'],
        implicated: false,
        implicationScore: 0,
      })),
      edges: [],
    };
    const ctx: ScoringContext = {
      evidence: symEvidence,
      graph: manyNodes,
      now: FIXED_NOW,
      priorIncidents: new Map(Array.from({ length: 5 }, (_, i) => [`symbol:s${i}`, 1] as const)),
    };
    const f = scoreCause(input, ctx).explanations.find((e) => e.factor === 'incident-history');
    expect(f!.delta).toBeLessThanOrEqual(0.1);
  });
});

describe('scoreCause — scenario 1: no evidence attached', () => {
  it('finalScore equals baseScore when no evidence is attached', () => {
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: [] });
    const ctx = makeCtx([]);
    const result = scoreCause(input, ctx);
    expect(result.finalScore).toBe(0.40);
  });

  it('band is "possible" for baseScore 0.40', () => {
    const result = scoreCause(makeInput({ baseScore: 0.40 }), makeCtx([]));
    expect(result.band).toBe('possible');
  });

  it('band is "observation" for baseScore 0.30', () => {
    const result = scoreCause(makeInput({ baseScore: 0.30 }), makeCtx([]));
    expect(result.band).toBe('observation');
  });

  it('band is "likely" for baseScore 0.70', () => {
    const result = scoreCause(makeInput({ baseScore: 0.70 }), makeCtx([]));
    expect(result.band).toBe('likely');
  });

  it('band is "likely" for baseScore 0.90 with no evidence (single-source ceiling)', () => {
    // No attached evidence → 0 distinct sources ≤ 1 → ceiling at 0.84 → 'likely'.
    const result = scoreCause(makeInput({ baseScore: 0.90 }), makeCtx([]));
    expect(result.band).toBe('likely');
    expect(result.finalScore).toBe(0.84);
  });

  it('returns no explanations when no factors fire', () => {
    const result = scoreCause(makeInput({ sourceEvidenceIds: [] }), makeCtx([]));
    expect(result.explanations).toHaveLength(0);
  });

  it('confidence equals finalScore', () => {
    const result = scoreCause(makeInput({ baseScore: 0.55 }), makeCtx([]));
    expect(result.confidence).toBe(result.finalScore);
  });

  it('affectedNodeIds defaults to [] when not provided', () => {
    const result = scoreCause(makeInput(), makeCtx([]));
    expect(result.affectedNodeIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: High-priority anomaly evidence → evidence-quality boost
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 2: high-priority evidence quality boost', () => {
  const highEv = makeEvidence('ev-high', 'log', 'logs', 0.9, 'high');
  const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-high'] });

  it('evidence-quality factor fires and is positive', () => {
    const result = scoreCause(input, makeCtx([highEv]));
    const factor = result.explanations.find((e) => e.factor === 'evidence-quality');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeGreaterThan(0);
  });

  it('finalScore is higher than baseScore', () => {
    const result = scoreCause(input, makeCtx([highEv]));
    expect(result.finalScore).toBeGreaterThan(0.40);
  });

  it('evidence-quality factor fires with negative delta for info-priority evidence', () => {
    const infoEv = makeEvidence('ev-info', 'queue-edge', 'queue', 0.75, 'info');
    const infoInput = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-info'] });
    const result = scoreCause(infoInput, makeCtx([infoEv]));
    const factor = result.explanations.find((e) => e.factor === 'evidence-quality');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeLessThan(0);
  });

  it('finalScore is lower than baseScore for all-info evidence', () => {
    const infoEv = makeEvidence('ev-info', 'queue-edge', 'queue', 0.75, 'info');
    const infoInput = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-info'] });
    const result = scoreCause(infoInput, makeCtx([infoEv]));
    expect(result.finalScore).toBeLessThan(0.40);
  });

  it('critical-priority evidence produces a larger boost than medium-priority', () => {
    const criticalEv = makeEvidence('ev-crit', 'log', 'logs', 1.0, 'critical');
    const mediumEv = makeEvidence('ev-med', 'log', 'logs', 0.6, 'medium');
    const criticalResult = scoreCause(
      makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-crit'] }),
      makeCtx([criticalEv]),
    );
    const mediumResult = scoreCause(
      makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-med'] }),
      makeCtx([mediumEv]),
    );
    expect(criticalResult.finalScore).toBeGreaterThan(mediumResult.finalScore);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Multi-provider evidence → source-diversity boost
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 3: source diversity boost', () => {
  const logEv = makeEvidence('ev-log', 'log', 'logs', 0.7, 'high');
  const queueEv = makeEvidence('ev-queue', 'queue-state', 'queue', 0.8, 'high');
  const stateEv = makeEvidence('ev-state', 'state', 'state', 0.7, 'medium');

  it('source-diversity factor fires for 2 providers', () => {
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-log', 'ev-queue'] });
    const result = scoreCause(input, makeCtx([logEv, queueEv]));
    const factor = result.explanations.find((e) => e.factor === 'source-diversity');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBe(0.05);
  });

  it('source-diversity factor fires with delta 0.10 for 3+ providers', () => {
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-log', 'ev-queue', 'ev-state'] });
    const result = scoreCause(input, makeCtx([logEv, queueEv, stateEv]));
    const factor = result.explanations.find((e) => e.factor === 'source-diversity');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBe(0.10);
  });

  it('no source-diversity factor for single-provider evidence', () => {
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-log'] });
    const result = scoreCause(input, makeCtx([logEv]));
    const factor = result.explanations.find((e) => e.factor === 'source-diversity');
    expect(factor).toBeUndefined();
  });

  it('3-provider diversity factor contributes a larger delta (+0.10) than 2-provider (+0.05)', () => {
    const twoInput = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-log', 'ev-queue'] });
    const threeInput = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-log', 'ev-queue', 'ev-state'] });
    const twoResult = scoreCause(twoInput, makeCtx([logEv, queueEv, stateEv]));
    const threeResult = scoreCause(threeInput, makeCtx([logEv, queueEv, stateEv]));
    const twoDelta = twoResult.explanations.find((e) => e.factor === 'source-diversity')!.delta;
    const threeDelta = threeResult.explanations.find((e) => e.factor === 'source-diversity')!.delta;
    expect(threeDelta).toBeGreaterThan(twoDelta);
    expect(twoDelta).toBe(0.05);
    expect(threeDelta).toBe(0.10);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Implicated graph node → graph-proximity boost
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 4: graph proximity boost', () => {
  it('graph-proximity factor fires when a matching implicated node exists', () => {
    const evId = 'ev-queue-state';
    const ev = makeEvidence(evId, 'queue-state', 'queue', 0.9, 'high');
    const graph: InvestigationGraph = {
      nodes: [
        {
          id: 'queue:payments',
          type: 'queue',
          label: 'payments',
          evidenceIds: [evId],
          implicated: true,
          implicationScore: 0.9,
        },
      ],
      edges: [],
    };
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: [evId] });
    const result = scoreCause(input, { evidence: [ev], graph, now: FIXED_NOW });
    const factor = result.explanations.find((e) => e.factor === 'graph-proximity');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeCloseTo(0.09, 2); // 0.9 * 0.10
    expect(result.finalScore).toBeGreaterThan(0.40);
  });

  it('graph-proximity factor does not fire for non-implicated nodes', () => {
    const evId = 'ev-healthy';
    const ev = makeEvidence(evId, 'queue-state', 'queue', 0.4, 'info');
    const graph: InvestigationGraph = {
      nodes: [
        {
          id: 'queue:payments',
          type: 'queue',
          label: 'payments',
          evidenceIds: [evId],
          implicated: false,
          implicationScore: 0.4,
        },
      ],
      edges: [],
    };
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: [evId] });
    const result = scoreCause(input, { evidence: [ev], graph, now: FIXED_NOW });
    const factor = result.explanations.find((e) => e.factor === 'graph-proximity');
    expect(factor).toBeUndefined();
  });

  it('graph-proximity factor does not fire when no evidence IDs match graph nodes', () => {
    const graph: InvestigationGraph = {
      nodes: [
        {
          id: 'queue:payments',
          type: 'queue',
          label: 'payments',
          evidenceIds: ['different-ev'],
          implicated: true,
          implicationScore: 0.9,
        },
      ],
      edges: [],
    };
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-unrelated'] });
    const result = scoreCause(input, { evidence: [], graph, now: FIXED_NOW });
    const factor = result.explanations.find((e) => e.factor === 'graph-proximity');
    expect(factor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Recency + recurrence → runtime-signals boost
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 5: runtime signals (recency + recurrence)', () => {
  it('runtime-signals fires with +0.05 for evidence within the last hour', () => {
    const recentTs = '2026-06-14T19:45:00.000Z'; // 15 min before FIXED_NOW
    const ev = makeEvidence('ev-recent', 'log', 'logs', 0.7, 'high', { timestamp: recentTs });
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-recent'] });
    const result = scoreCause(input, makeCtx([ev]));
    const factor = result.explanations.find((e) => e.factor === 'runtime-signals');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeGreaterThanOrEqual(0.05);
  });

  it('runtime-signals fires with +0.02 for evidence within the last 24 hours', () => {
    const recentTs = '2026-06-14T10:00:00.000Z'; // ~10h before FIXED_NOW
    const ev = makeEvidence('ev-today', 'log', 'logs', 0.7, 'high', { timestamp: recentTs });
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-today'] });
    const result = scoreCause(input, makeCtx([ev]));
    const factor = result.explanations.find((e) => e.factor === 'runtime-signals');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeCloseTo(0.02, 2);
  });

  it('runtime-signals fires for a new log signature (isNew=true)', () => {
    const ev = makeEvidence('ev-new-err', 'log', 'logs', 0.95, 'critical', {
      isNew: true,
    });
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-new-err'] });
    const result = scoreCause(input, makeCtx([ev]));
    const factor = result.explanations.find((e) => e.factor === 'runtime-signals');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeGreaterThanOrEqual(0.05);
    expect(factor!.reason).toContain('isNew=true');
  });

  it('runtime-signals fires for a spiking log signature (ratio >= 3)', () => {
    const ev = makeEvidence('ev-spike', 'log', 'logs', 0.9, 'high', {
      ratio: 4.5,
    });
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-spike'] });
    const result = scoreCause(input, makeCtx([ev]));
    const factor = result.explanations.find((e) => e.factor === 'runtime-signals');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeGreaterThanOrEqual(0.03);
    expect(factor!.reason).toContain('spike');
  });

  it('runtime-signals does not fire for evidence in the 24h–3d neutral window', () => {
    const oldTs = '2026-06-12T20:00:00.000Z'; // 2 days before FIXED_NOW
    const ev = makeEvidence('ev-old', 'log', 'logs', 0.7, 'high', { timestamp: oldTs });
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-old'] });
    const result = scoreCause(input, makeCtx([ev]));
    const factor = result.explanations.find((e) => e.factor === 'runtime-signals');
    expect(factor).toBeUndefined();
  });

  it('runtime-signals fires with -0.02 decay for evidence 3–7 days old', () => {
    const staleTs = '2026-06-10T20:00:00.000Z'; // 4 days before FIXED_NOW
    const ev = makeEvidence('ev-stale', 'log', 'logs', 0.7, 'high', { timestamp: staleTs });
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-stale'] });
    const result = scoreCause(input, makeCtx([ev]));
    const factor = result.explanations.find((e) => e.factor === 'runtime-signals');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeCloseTo(-0.02, 3);
    expect(factor!.reason).toContain('3–7 days');
  });

  it('runtime-signals fires with -0.05 decay for evidence older than 7 days', () => {
    const veryStaleTs = '2026-06-06T20:00:00.000Z'; // 8 days before FIXED_NOW
    const ev = makeEvidence('ev-very-stale', 'log', 'logs', 0.7, 'high', { timestamp: veryStaleTs });
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-very-stale'] });
    const result = scoreCause(input, makeCtx([ev]));
    const factor = result.explanations.find((e) => e.factor === 'runtime-signals');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeCloseTo(-0.05, 3);
    expect(factor!.reason).toContain('7 days');
  });

  it('stale evidence lowers finalScore below baseScore', () => {
    const veryStaleTs = '2026-06-06T20:00:00.000Z'; // 8 days
    // No priority so evidence-quality factor is neutral — only decay fires.
    const ev = makeEvidence('ev-ancient', 'log', 'logs', 0.6, undefined, { timestamp: veryStaleTs });
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-ancient'] });
    const result = scoreCause(input, makeCtx([ev]));
    expect(result.finalScore).toBeLessThan(0.50);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: Provider reliability
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 11: provider reliability', () => {
  it('fires with +0.03 when average source reliability is >= 0.80', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.7, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const ctx: ScoringContext = {
      ...makeCtx([ev]),
      providerReliability: { queue: 0.90 },
    };
    const result = scoreCause(input, ctx);
    const factor = result.explanations.find((e) => e.factor === 'provider-reliability');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBe(0.03);
  });

  it('fires with -0.03 when average source reliability is < 0.50', () => {
    const ev = makeEvidence('ev-q', 'log', 'logs', 0.7, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const ctx: ScoringContext = {
      ...makeCtx([ev]),
      providerReliability: { logs: 0.30 },
    };
    const result = scoreCause(input, ctx);
    const factor = result.explanations.find((e) => e.factor === 'provider-reliability');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBe(-0.03);
  });

  it('does not fire when average reliability is in the neutral range (0.50–0.79)', () => {
    const ev = makeEvidence('ev-q', 'log', 'logs', 0.7, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const ctx: ScoringContext = {
      ...makeCtx([ev]),
      providerReliability: { logs: 0.65 },
    };
    const result = scoreCause(input, ctx);
    const factor = result.explanations.find((e) => e.factor === 'provider-reliability');
    expect(factor).toBeUndefined();
  });

  it('does not fire when ctx.providerReliability is absent', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.7, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const result = scoreCause(input, makeCtx([ev]));
    const factor = result.explanations.find((e) => e.factor === 'provider-reliability');
    expect(factor).toBeUndefined();
  });

  it('unlisted sources default to 0.65 (neutral) in reliability calculation', () => {
    // Use a valid ProviderKind but don't include it in the reliability map.
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.7, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const ctx: ScoringContext = {
      ...makeCtx([ev]),
      providerReliability: {}, // empty map — 'queue' source not listed, defaults to 0.65
    };
    const result = scoreCause(input, ctx);
    const factor = result.explanations.find((e) => e.factor === 'provider-reliability');
    // avg = 0.65 (default) → neutral range → no factor
    expect(factor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: Request / implicated-path context
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 12: request/path context', () => {
  function makeServiceGraph(service: string, evId: string, implicated: boolean): InvestigationGraph {
    return {
      nodes: [
        {
          id: `service:${service}`,
          type: 'service',
          label: service,
          evidenceIds: [evId],
          implicated,
          implicationScore: implicated ? 0.8 : 0.2,
        },
      ],
      edges: [],
    };
  }

  it('fires with +0.04 when queried service is an implicated graph node', () => {
    const evId = 'ev-log';
    const ev = makeEvidence(evId, 'log', 'logs', 0.8, 'high');
    const graph = makeServiceGraph('leadcall-api-prod', evId, true);
    const input = makeInput({ baseScore: 0.45, sourceEvidenceIds: [evId] });
    const ctx: ScoringContext = {
      evidence: [ev],
      graph,
      now: FIXED_NOW,
      request: { hint: 'zoho sync', service: 'leadcall-api-prod' },
    };
    const result = scoreCause(input, ctx);
    const factor = result.explanations.find((e) => e.factor === 'request-context');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBe(0.04);
  });

  it('does not fire when the service node is not implicated', () => {
    const evId = 'ev-log';
    const ev = makeEvidence(evId, 'log', 'logs', 0.8, 'high');
    const graph = makeServiceGraph('leadcall-api-prod', evId, false);
    const input = makeInput({ baseScore: 0.45, sourceEvidenceIds: [evId] });
    const ctx: ScoringContext = {
      evidence: [ev],
      graph,
      now: FIXED_NOW,
      request: { service: 'leadcall-api-prod' },
    };
    const result = scoreCause(input, ctx);
    const factor = result.explanations.find((e) => e.factor === 'request-context');
    expect(factor).toBeUndefined();
  });

  it('does not fire when the cause evidence does not overlap with the service node', () => {
    const ev = makeEvidence('ev-other', 'log', 'logs', 0.8, 'high');
    const graph = makeServiceGraph('leadcall-api-prod', 'ev-different', true);
    const input = makeInput({ baseScore: 0.45, sourceEvidenceIds: ['ev-other'] });
    const ctx: ScoringContext = {
      evidence: [ev],
      graph,
      now: FIXED_NOW,
      request: { service: 'leadcall-api-prod' },
    };
    const result = scoreCause(input, ctx);
    const factor = result.explanations.find((e) => e.factor === 'request-context');
    expect(factor).toBeUndefined();
  });

  it('does not fire when ctx.request is absent', () => {
    const evId = 'ev-log';
    const ev = makeEvidence(evId, 'log', 'logs', 0.8, 'high');
    const graph = makeServiceGraph('leadcall-api-prod', evId, true);
    const input = makeInput({ baseScore: 0.45, sourceEvidenceIds: [evId] });
    const result = scoreCause(input, { evidence: [ev], graph, now: FIXED_NOW });
    const factor = result.explanations.find((e) => e.factor === 'request-context');
    expect(factor).toBeUndefined();
  });

  it('does not fire when request has only hint (no service)', () => {
    const evId = 'ev-log';
    const ev = makeEvidence(evId, 'log', 'logs', 0.8, 'high');
    const graph = makeServiceGraph('leadcall-api-prod', evId, true);
    const input = makeInput({ baseScore: 0.45, sourceEvidenceIds: [evId] });
    const ctx: ScoringContext = {
      evidence: [ev],
      graph,
      now: FIXED_NOW,
      request: { hint: 'zoho sync crashed' },
    };
    const result = scoreCause(input, ctx);
    const factor = result.explanations.find((e) => e.factor === 'request-context');
    expect(factor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Blast radius → blast-radius boost
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 6: blast radius boost', () => {
  it('blast-radius factor fires when metadata.blastRadius > 0', () => {
    const input = makeInput({
      baseScore: 0.40,
      metadata: { blastRadius: 20 },
    });
    const result = scoreCause(input, makeCtx([]));
    const factor = result.explanations.find((e) => e.factor === 'blast-radius');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeCloseTo(0.05, 3);
  });

  it('blast-radius delta is proportional and capped at 0.05 for large counts', () => {
    const large = makeInput({ baseScore: 0.40, metadata: { blastRadius: 100 } });
    const small = makeInput({ baseScore: 0.40, metadata: { blastRadius: 5 } });
    const largeResult = scoreCause(large, makeCtx([]));
    const smallResult = scoreCause(small, makeCtx([]));
    expect(largeResult.finalScore).toBeGreaterThan(smallResult.finalScore);
    // Cap: 100 affected → same as 20 affected (both max out at 0.05)
    const cappedInput = makeInput({ baseScore: 0.40, metadata: { blastRadius: 50 } });
    const cappedResult = scoreCause(cappedInput, makeCtx([]));
    expect(cappedResult.finalScore).toBeCloseTo(largeResult.finalScore, 3);
  });

  it('blast-radius factor does not fire for zero-affected', () => {
    const input = makeInput({ baseScore: 0.40, metadata: { blastRadius: 0 } });
    const result = scoreCause(input, makeCtx([]));
    const factor = result.explanations.find((e) => e.factor === 'blast-radius');
    expect(factor).toBeUndefined();
  });

  it('blast-radius factor does not fire when metadata is absent', () => {
    const input = makeInput({ baseScore: 0.40 });
    const result = scoreCause(input, makeCtx([]));
    const factor = result.explanations.find((e) => e.factor === 'blast-radius');
    expect(factor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Structural-only evidence → signal-strength penalty
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 7: structural-only penalty', () => {
  it('signal-strength penalty fires when all evidence is structural', () => {
    const symbolEv = makeEvidence('ev-sym', 'symbol', 'code', 0.9, 'info');
    const flowEv = makeEvidence('ev-flow', 'flow', 'code', 0.6, 'info');
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-sym', 'ev-flow'] });
    const result = scoreCause(input, makeCtx([symbolEv, flowEv]));
    const factor = result.explanations.find((e) => e.factor === 'signal-strength');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBe(-0.05);
  });

  it('finalScore is lower than baseScore for structural-only evidence', () => {
    const symbolEv = makeEvidence('ev-sym', 'symbol', 'code', 0.9, 'info');
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-sym'] });
    const result = scoreCause(input, makeCtx([symbolEv]));
    expect(result.finalScore).toBeLessThan(0.40);
  });

  it('signal-strength boost fires for high-relevance anomaly evidence (>= 0.85)', () => {
    const logEv = makeEvidence('ev-log', 'log', 'logs', 0.9, 'high');
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-log'] });
    const result = scoreCause(input, makeCtx([logEv]));
    const factor = result.explanations.find((e) => e.factor === 'signal-strength');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBe(0.03);
  });

  it('signal-strength does not fire for anomaly evidence below the 0.85 relevance threshold', () => {
    const logEv = makeEvidence('ev-log', 'log', 'logs', 0.7, 'medium');
    const input = makeInput({ baseScore: 0.40, sourceEvidenceIds: ['ev-log'] });
    const result = scoreCause(input, makeCtx([logEv]));
    const factor = result.explanations.find((e) => e.factor === 'signal-strength');
    expect(factor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: All factors combined
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 8: all factors combined', () => {
  it('multiple factors produce a meaningful score above baseScore', () => {
    const recentTs = '2026-06-14T19:55:00.000Z'; // 5 min before FIXED_NOW
    const queueStateEv = makeEvidence('ev-qs', 'queue-state', 'queue', 0.9, 'high', {
      timestamp: recentTs,
    });
    const logEv = makeEvidence('ev-log', 'log', 'logs', 0.95, 'critical', {
      timestamp: recentTs,
      isNew: true,
    });
    const graph: InvestigationGraph = {
      nodes: [
        {
          id: 'queue:payments',
          type: 'queue',
          label: 'payments',
          evidenceIds: ['ev-qs'],
          implicated: true,
          implicationScore: 0.9,
        },
      ],
      edges: [],
    };
    const input = makeInput({
      id: 'cause:queue-backlog:payments',
      category: 'queue-backlog',
      baseScore: 0.45,
      sourceEvidenceIds: ['ev-qs', 'ev-log'],
      metadata: { blastRadius: 15 },
    });
    const result = scoreCause(input, { evidence: [queueStateEv, logEv], graph, now: FIXED_NOW });

    expect(result.finalScore).toBeGreaterThan(0.65); // should reach 'likely' band
    expect(result.band).toMatch(/^(likely|highly-likely)$/);
    expect(result.explanations.length).toBeGreaterThanOrEqual(3);

    const factorNames = result.explanations.map((e) => e.factor);
    expect(factorNames).toContain('evidence-quality');
    expect(factorNames).toContain('source-diversity');
    expect(factorNames).toContain('graph-proximity');
    expect(factorNames).toContain('runtime-signals');
  });

  it('all fields are populated on the returned CauseCandidate', () => {
    const ev = makeEvidence('ev-1', 'log', 'logs', 0.8, 'high');
    const input: CauseInput = {
      id: 'cause:test:full',
      title: 'Full cause',
      category: 'queue-backlog',
      sourceEvidenceIds: ['ev-1'],
      affectedNodeIds: ['queue:payments'],
      baseScore: 0.45,
      metadata: { blastRadius: 5 },
    };
    const result = scoreCause(input, makeCtx([ev]));
    expect(result.id).toBe('cause:test:full');
    expect(result.title).toBe('Full cause');
    expect(result.category).toBe('queue-backlog');
    expect(result.sourceEvidenceIds).toEqual(['ev-1']);
    expect(result.affectedNodeIds).toEqual(['queue:payments']);
    expect(result.baseScore).toBe(0.45);
    expect(result.finalScore).toBeGreaterThanOrEqual(0);
    expect(result.finalScore).toBeLessThanOrEqual(1);
    expect(result.confidence).toBe(result.finalScore);
    expect(['highly-likely', 'likely', 'possible', 'observation']).toContain(result.band);
    expect(Array.isArray(result.explanations)).toBe(true);
    expect(result.metadata).toEqual({ blastRadius: 5 });
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: Finding uncertainty penalty
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 9: finding uncertainty', () => {
  it('finding-uncertainty fires when relevant findings have max confidence < 0.60', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.85, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const findings: ScoringFinding[] = [
      { kind: 'anomaly', confidence: 0.40, evidenceIds: ['ev-q'] },
    ];
    const result = scoreCause(input, { ...makeCtx([ev]), findings });
    const factor = result.explanations.find((e) => e.factor === 'finding-uncertainty');
    expect(factor).toBeDefined();
    expect(factor!.delta).toBeLessThan(0); // always negative
    // delta = -(0.60 - 0.40) * 0.10 = -0.020
    expect(factor!.delta).toBeCloseTo(-0.02, 3);
  });

  it('finding-uncertainty does not fire when max confidence >= 0.60', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.85, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const findings: ScoringFinding[] = [
      { kind: 'anomaly', confidence: 0.75, evidenceIds: ['ev-q'] },
    ];
    const result = scoreCause(input, { ...makeCtx([ev]), findings });
    const factor = result.explanations.find((e) => e.factor === 'finding-uncertainty');
    expect(factor).toBeUndefined();
  });

  it('observation findings are not counted', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.85, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const findings: ScoringFinding[] = [
      { kind: 'observation', confidence: 0.20, evidenceIds: ['ev-q'] },
    ];
    const result = scoreCause(input, { ...makeCtx([ev]), findings });
    const factor = result.explanations.find((e) => e.factor === 'finding-uncertainty');
    expect(factor).toBeUndefined();
  });

  it('finding-uncertainty does not fire when no evidence IDs overlap', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.85, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const findings: ScoringFinding[] = [
      { kind: 'anomaly', confidence: 0.30, evidenceIds: ['ev-other'] },
    ];
    const result = scoreCause(input, { ...makeCtx([ev]), findings });
    const factor = result.explanations.find((e) => e.factor === 'finding-uncertainty');
    expect(factor).toBeUndefined();
  });

  it('finding-uncertainty does not fire when ctx.findings is omitted', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.85, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const result = scoreCause(input, makeCtx([ev]));
    const factor = result.explanations.find((e) => e.factor === 'finding-uncertainty');
    expect(factor).toBeUndefined();
  });

  it('finding-uncertainty never produces a positive delta', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.85, 'high');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    // Even with very low confidence findings, delta must be ≤ 0
    for (const confidence of [0, 0.1, 0.3, 0.55, 0.59]) {
      const findings: ScoringFinding[] = [
        { kind: 'anomaly', confidence, evidenceIds: ['ev-q'] },
      ];
      const result = scoreCause(input, { ...makeCtx([ev]), findings });
      for (const exp of result.explanations) {
        if (exp.factor === 'finding-uncertainty') {
          expect(exp.delta).toBeLessThanOrEqual(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: Single-source ceiling
// ---------------------------------------------------------------------------

describe('scoreCause — scenario 10: single-source ceiling', () => {
  it('single provider cannot reach highly-likely (capped at 0.84)', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.95, 'critical');
    // Provide high baseScore that would normally exceed 0.85
    const input = makeInput({ baseScore: 0.80, sourceEvidenceIds: ['ev-q'] });
    const result = scoreCause(input, makeCtx([ev]));
    expect(result.finalScore).toBeLessThanOrEqual(0.84);
    expect(result.band).not.toBe('highly-likely');
  });

  it('two independent providers can reach highly-likely', () => {
    const qEv = makeEvidence('ev-q', 'queue-state', 'queue', 0.95, 'critical');
    const logEv = makeEvidence('ev-log', 'log', 'logs', 0.95, 'critical');
    const input = makeInput({ baseScore: 0.80, sourceEvidenceIds: ['ev-q', 'ev-log'] });
    const result = scoreCause(input, makeCtx([qEv, logEv]));
    // Two distinct sources → ceiling does not apply
    expect(result.finalScore).toBeGreaterThan(0.84);
    expect(result.band).toBe('highly-likely');
  });

  it('single-source-ceiling explanation appears when the cap fires', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.95, 'critical');
    const input = makeInput({ baseScore: 0.80, sourceEvidenceIds: ['ev-q'] });
    const result = scoreCause(input, makeCtx([ev]));
    const ceiling = result.explanations.find((e) => e.factor === 'single-source-ceiling');
    expect(ceiling).toBeDefined();
    expect(ceiling!.delta).toBeLessThan(0);
  });

  it('ceiling does not fire when finalScore is already at or below 0.84', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.6, 'medium');
    const input = makeInput({ baseScore: 0.50, sourceEvidenceIds: ['ev-q'] });
    const result = scoreCause(input, makeCtx([ev]));
    expect(result.finalScore).toBeLessThanOrEqual(0.84);
    const ceiling = result.explanations.find((e) => e.factor === 'single-source-ceiling');
    expect(ceiling).toBeUndefined();
  });

  it('two same-source evidence items are still single-source (by provider kind)', () => {
    const ev1 = makeEvidence('ev-q1', 'queue-state', 'queue', 0.95, 'critical');
    const ev2 = makeEvidence('ev-q2', 'queue-state', 'queue', 0.95, 'critical');
    const input = makeInput({ baseScore: 0.80, sourceEvidenceIds: ['ev-q1', 'ev-q2'] });
    const result = scoreCause(input, makeCtx([ev1, ev2]));
    expect(result.finalScore).toBeLessThanOrEqual(0.84);
    expect(result.band).not.toBe('highly-likely');
  });
});

// ---------------------------------------------------------------------------
// affectedNodeIds — derived from graph when not supplied
// ---------------------------------------------------------------------------

describe('scoreCause — affectedNodeIds derivation', () => {
  it('affectedNodeIds is derived from implicated graph nodes when not supplied', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.85, 'high');
    const graph: InvestigationGraph = {
      nodes: [
        {
          id: 'queue:payments',
          type: 'queue',
          label: 'payments',
          evidenceIds: ['ev-q'],
          implicated: true,
          implicationScore: 0.85,
        },
      ],
      edges: [],
    };
    const input = makeInput({ baseScore: 0.45, sourceEvidenceIds: ['ev-q'] });
    const result = scoreCause(input, { evidence: [ev], graph, now: FIXED_NOW });
    expect(result.affectedNodeIds).toContain('queue:payments');
  });

  it('affectedNodeIds uses the caller-supplied list when provided', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.85, 'high');
    const input: CauseInput = {
      id: 'cause:test',
      title: 'Test',
      category: 'other',
      sourceEvidenceIds: ['ev-q'],
      affectedNodeIds: ['custom:node:1'],
      baseScore: 0.45,
    };
    const result = scoreCause(input, makeCtx([ev]));
    expect(result.affectedNodeIds).toEqual(['custom:node:1']);
  });

  it('non-implicated nodes are not included in affectedNodeIds', () => {
    const ev = makeEvidence('ev-q', 'queue-state', 'queue', 0.85, 'high');
    const graph: InvestigationGraph = {
      nodes: [
        {
          id: 'queue:healthy',
          type: 'queue',
          label: 'healthy',
          evidenceIds: ['ev-q'],
          implicated: false,
          implicationScore: 0.3,
        },
      ],
      edges: [],
    };
    const input = makeInput({ baseScore: 0.45, sourceEvidenceIds: ['ev-q'] });
    const result = scoreCause(input, { evidence: [ev], graph, now: FIXED_NOW });
    expect(result.affectedNodeIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// rankCauses — ordering and limit
// ---------------------------------------------------------------------------

describe('rankCauses', () => {
  it('returns causes sorted by finalScore descending', () => {
    const highEv = makeEvidence('ev-high', 'log', 'logs', 0.9, 'critical');
    const lowEv = makeEvidence('ev-low', 'log', 'logs', 0.4, 'low');
    const inputs: CauseInput[] = [
      { id: 'cause:a', title: 'Low cause', category: 'other', sourceEvidenceIds: ['ev-low'], baseScore: 0.25 },
      { id: 'cause:b', title: 'High cause', category: 'other', sourceEvidenceIds: ['ev-high'], baseScore: 0.55 },
    ];
    const results = rankCauses(inputs, makeCtx([highEv, lowEv]));
    expect(results[0]!.id).toBe('cause:b');
    expect(results[1]!.id).toBe('cause:a');
  });

  it('respects the limit parameter', () => {
    const inputs: CauseInput[] = Array.from({ length: 5 }, (_, i) => ({
      id: `cause:${i}`,
      title: `Cause ${i}`,
      category: 'other',
      sourceEvidenceIds: [],
      baseScore: i * 0.1,
    }));
    const results = rankCauses(inputs, makeCtx([]), 2);
    expect(results).toHaveLength(2);
  });

  it('uses id as a deterministic tiebreaker for equal finalScores', () => {
    const inputs: CauseInput[] = [
      { id: 'cause:z', title: 'Z cause', category: 'other', sourceEvidenceIds: [], baseScore: 0.50 },
      { id: 'cause:a', title: 'A cause', category: 'other', sourceEvidenceIds: [], baseScore: 0.50 },
    ];
    const results = rankCauses(inputs, makeCtx([]));
    // 'cause:a' < 'cause:z' alphabetically → cause:a wins the tiebreaker
    expect(results[0]!.id).toBe('cause:a');
    expect(results[1]!.id).toBe('cause:z');
  });

  it('returns at most 3 results by default', () => {
    const inputs: CauseInput[] = Array.from({ length: 10 }, (_, i) => ({
      id: `cause:${i}`,
      title: `Cause ${i}`,
      category: 'other',
      sourceEvidenceIds: [],
      baseScore: 0.50,
    }));
    const results = rankCauses(inputs, makeCtx([]));
    expect(results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// HOR-402 substage-1a — selectHeadlineCause is reorder-safe (score-based, not positional)
// ---------------------------------------------------------------------------

describe('selectHeadlineCause — reorder-safe headline selection', () => {
  function cand(id: string, finalScore: number, sourceEvidenceIds: string[]): CauseCandidate {
    return {
      id,
      title: `Cause ${id}`,
      category: 'other',
      sourceEvidenceIds,
      affectedNodeIds: [],
      baseScore: finalScore,
      finalScore,
      confidence: finalScore,
      band: 'possible',
      explanations: [],
    };
  }

  // A cause is "linked" iff it cites the seed's evidence id.
  const isLinked = (ids: string[]): boolean => ids.includes('ev_seed');

  // Replicates the engine's confidence + unlinked-headline cap (engine.ts h. summary).
  const cappedConfidence = (causes: readonly CauseCandidate[], base = 0.8): number => {
    const { headlineCause, headlineLinked } = selectHeadlineCause(causes, isLinked);
    return headlineCause && !headlineLinked ? Math.min(base, 0.6) : base;
  };

  // All distinct permutations of a 3-element array (exhaustive shuffle coverage).
  const permutations = <T>(xs: readonly T[]): T[][] => {
    if (xs.length <= 1) return [xs.slice()];
    return xs.flatMap((x, i) =>
      permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
    );
  };

  it('picks the highest-finalScore cause as topCause regardless of array order (argmax, not [0])', () => {
    const causes = [cand('a', 0.5, []), cand('b', 0.9, []), cand('c', 0.3, [])];
    for (const order of permutations(causes)) {
      expect(selectHeadlineCause(order, isLinked).topCause?.id).toBe('b');
    }
  });

  it('headline, headlineLinked AND capped confidence are identical in score order vs ANY shuffle', () => {
    // Two LINKED causes of different scores + one higher UNLINKED cause. The headline must be the
    // strongest LINKED cause (l-hi=0.7), never the higher unlinked one (u=0.9) and never the weaker
    // linked one (l-lo=0.4) — and that choice must not depend on array order. (A positional `.find()`
    // over a shuffle could otherwise return l-lo first.)
    const u = cand('u', 0.9, ['ev_noise']);
    const lHi = cand('l-hi', 0.7, ['ev_seed']);
    const lLo = cand('l-lo', 0.4, ['ev_seed']);
    const sorted = [u, lHi, lLo]; // finalScore desc — the order rankCauses produces today

    const baseline = selectHeadlineCause(sorted, isLinked);
    expect(baseline.headlineCause?.id).toBe('l-hi');
    expect(baseline.headlineLinked).toBe(true);
    expect(cappedConfidence(sorted)).toBe(0.8); // linked headline ⇒ no cap

    for (const order of permutations(sorted)) {
      const r = selectHeadlineCause(order, isLinked);
      expect(r.headlineCause?.id).toBe(baseline.headlineCause?.id);
      expect(r.headlineLinked).toBe(baseline.headlineLinked);
      expect(cappedConfidence(order)).toBe(cappedConfidence(sorted));
    }
  });

  it('caps confidence to 0.6 when the (order-independent) headline is unlinked, in every order', () => {
    // No linked cause clears the bar ⇒ the top cause headlines unlinked ⇒ 0.6 cap, always.
    const causes = [cand('a', 0.9, ['ev_noise']), cand('b', 0.5, ['ev_other'])];
    for (const order of permutations(causes)) {
      const r = selectHeadlineCause(order, isLinked);
      expect(r.headlineCause?.id).toBe('a'); // argmax, not the shuffled first element
      expect(r.headlineLinked).toBe(false);
      expect(cappedConfidence(order)).toBe(0.6);
    }
  });

  it('enforces the ≥0.2 bar: a sub-threshold top cause does not headline (HOR-340/336)', () => {
    const { headlineCause } = selectHeadlineCause([cand('weak', 0.09, ['ev_seed'])], isLinked);
    expect(headlineCause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HOR-404 — the optional reranker is honesty-bounded: it may change WHICH eligible
// cause headlines, but never promotes an ineligible cause and never moves topCause
// (the ceiling basis) or any score.
// ---------------------------------------------------------------------------

describe('selectHeadlineCause — HOR-404 reranker (honesty-bounded)', () => {
  function cand(id: string, finalScore: number, sourceEvidenceIds: string[]): CauseCandidate {
    return {
      id,
      title: `Cause ${id}`,
      category: 'other',
      sourceEvidenceIds,
      affectedNodeIds: [],
      baseScore: finalScore,
      finalScore,
      confidence: finalScore,
      band: 'possible',
      explanations: [],
    };
  }
  const isLinked = (ids: string[]): boolean => ids.includes('ev_seed');
  // A stand-in "learned order": rank candidates by a fixed id priority.
  const rerankByIds =
    (priority: string[]) =>
    (cs: readonly CauseCandidate[]): CauseCandidate[] =>
      [...cs].sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));

  it('promotes a lower-finalScore ELIGIBLE linked cause to headline; topCause stays finalScore argmax', () => {
    const causes = [cand('strong', 0.8, ['ev_seed']), cand('weak', 0.5, ['ev_seed'])];
    const r = selectHeadlineCause(causes, isLinked, rerankByIds(['weak', 'strong']));
    expect(r.headlineCause?.id).toBe('weak'); // reranker changed the headline
    expect(r.headlineLinked).toBe(true);
    expect(r.topCause?.id).toBe('strong'); // ceiling basis UNCHANGED (finalScore argmax)
  });

  it('NEVER promotes a sub-0.2 cause, even when the reranker ranks it first', () => {
    const causes = [cand('ok', 0.5, ['ev_seed']), cand('tiny', 0.1, ['ev_seed'])];
    const r = selectHeadlineCause(causes, isLinked, rerankByIds(['tiny', 'ok']));
    expect(r.headlineCause?.id).toBe('ok');
  });

  it('NEVER promotes an UNLINKED cause when a linked-eligible one exists', () => {
    const causes = [cand('linked', 0.5, ['ev_seed']), cand('unlinked', 0.9, ['ev_other'])];
    const r = selectHeadlineCause(causes, isLinked, rerankByIds(['unlinked', 'linked']));
    expect(r.headlineCause?.id).toBe('linked');
    expect(r.headlineLinked).toBe(true);
  });

  it('no reranker ⇒ headline is the finalScore argmax among eligible (behavior preserved)', () => {
    const causes = [cand('a', 0.5, ['ev_seed']), cand('b', 0.8, ['ev_seed'])];
    expect(selectHeadlineCause(causes, isLinked).headlineCause?.id).toBe('b');
  });

  it('a reranker returning foreign candidates falls back to finalScore argmax (includes guard)', () => {
    const causes = [cand('a', 0.5, ['ev_seed']), cand('b', 0.8, ['ev_seed'])];
    const bogus = (): CauseCandidate[] => [cand('ghost', 1.0, ['ev_seed'])];
    const r = selectHeadlineCause(causes, isLinked, bogus);
    expect(r.headlineCause?.id).toBe('b');
  });
});
