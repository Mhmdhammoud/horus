/**
 * HOR-31 — Unit tests for simulate.ts (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, Evidence } from '@horus/core';
import type { InvestigationReport } from './types.js';
import type { ValidatedHypothesis } from './validate.js';
import type { BoundaryCrossing } from './timeline.js';
import type { EvidenceGap } from './gaps.js';
import { SCENARIOS, getScenario, evaluateScenario } from './simulate.js';
import { renderSimulation } from './render-simulate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSymbol(name: string): Symbol {
  return { id: globalThis.crypto.randomUUID(), name, filePath: `src/${name}.ts` };
}

function makeHypothesis(category: string): ValidatedHypothesis {
  return {
    id: globalThis.crypto.randomUUID(),
    category,
    statement: `Hypothesis: ${category}`,
    confidence: 0.5,
    priorConfidence: 0.5,
    verdict: 'unconfirmed',
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    supportingPresent: 0,
    contradictingPresent: 0,
    rationale: '0 supporting / 0 contradicting evidence present.',
  };
}

function makeBoundaryCrossing(): BoundaryCrossing {
  return {
    queueName: 'zoho-sync-realtime',
    producer: 'ZohoSyncProducer',
    worker: 'ZohoSyncWorker',
    evidenceId: globalThis.crypto.randomUUID(),
  };
}

function makeGap(): EvidenceGap {
  return {
    dimension: 'metrics',
    why: 'No metrics available.',
    nextSource: 'Prometheus',
    confidenceImpact: 0.1,
  };
}

function makeCommitEvidence(): Evidence {
  return {
    id: globalThis.crypto.randomUUID(),
    source: 'history',
    kind: 'commit',
    title: 'chore: touch zoho sync worker',
    relevance: 0.6,
    payload: {},
    links: {},
    provenance: { query: 'git log', collectedAt: '2026-06-16T10:00:00Z' },
  };
}

/** A fully-populated report that should satisfy all expected signals. */
function makeFullReport(): InvestigationReport {
  const seeds: Symbol[] = [makeSymbol('ZohoRealtimeSyncWorker')];

  const boundaryCrossings: BoundaryCrossing[] = [makeBoundaryCrossing()];

  const hypotheses: ValidatedHypothesis[] = [
    makeHypothesis('queue-backlog'),
    makeHypothesis('worker-slowdown'),
    makeHypothesis('deployment-regression'),
    makeHypothesis('external-api-latency'),
    makeHypothesis('infrastructure'),
    makeHypothesis('retry-storm'),
  ];

  const gaps: EvidenceGap[] = [makeGap()];

  return {
    id: globalThis.crypto.randomUUID(),
    input: { hint: 'zoho realtime sync delays' },
    summary: 'Synthetic full report.',
    seeds,
    evidence: [makeCommitEvidence()],
    timeline: { events: [], boundaryCrossings },
    correlation: { groups: [], chains: [], missing: [] },
    findings: [],
    suspectedCauses: [],
    hypotheses,
    similarIncidents: [],
    gapAnalysis: { gaps, blindSpots: ['Cannot see latency.'], confidenceCeiling: 0.9 },
    graph: { nodes: [], edges: [] },
    confidence: 0.5,
    nextActions: ['Check BullMQ queue depth.'],
  };
}

/** A mostly-empty report that should fail most checks. */
function makeEmptyReport(): InvestigationReport {
  return {
    id: globalThis.crypto.randomUUID(),
    input: { hint: 'zoho realtime sync delays' },
    summary: 'Nothing found.',
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
    confidence: 0.1,
    nextActions: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SCENARIOS', () => {
  it('contains exactly 5 scenarios', () => {
    expect(SCENARIOS).toHaveLength(5);
  });

  it('contains all 5 expected scenario ids', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(ids).toContain('queue-backlog');
    expect(ids).toContain('external-api-outage');
    expect(ids).toContain('deployment-regression');
    expect(ids).toContain('database-slowdown');
    expect(ids).toContain('cache-failure');
  });

  it('every scenario has a non-empty title, symptom, hint, and at least one expectedSignal', () => {
    for (const s of SCENARIOS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.symptom.length).toBeGreaterThan(0);
      expect(s.hint.length).toBeGreaterThan(0);
      expect(s.expectedSignals.length).toBeGreaterThan(0);
      expect(s.coachingTips.length).toBeGreaterThan(0);
    }
  });
});

describe('getScenario', () => {
  it('returns the queue-backlog scenario by id', () => {
    const s = getScenario('queue-backlog');
    expect(s).not.toBeNull();
    expect(s?.id).toBe('queue-backlog');
  });

  it('returns null for an unknown id', () => {
    const s = getScenario('nope');
    expect(s).toBeNull();
  });
});

describe('evaluateScenario — queue-backlog', () => {
  it('passes all checks when the report surfaces every expected signal', () => {
    const scenario = getScenario('queue-backlog');
    expect(scenario).not.toBeNull();

    const report = makeFullReport();
    const evaluation = evaluateScenario(scenario!, report);

    expect(evaluation.total).toBe(scenario!.expectedSignals.length);
    expect(evaluation.passed).toBe(evaluation.total);
    for (const check of evaluation.checks) {
      expect(check.ok).toBe(true);
    }
  });

  it('passes fewer checks against an empty report', () => {
    const scenario = getScenario('queue-backlog');
    expect(scenario).not.toBeNull();

    const emptyReport = makeEmptyReport();
    const evaluation = evaluateScenario(scenario!, emptyReport);

    expect(evaluation.passed).toBeLessThan(evaluation.total);
  });

  it('empty report yields passed === 0 for queue-backlog (all signals absent)', () => {
    const scenario = getScenario('queue-backlog');
    expect(scenario).not.toBeNull();

    const emptyReport = makeEmptyReport();
    const evaluation = evaluateScenario(scenario!, emptyReport);

    expect(evaluation.passed).toBe(0);
    for (const check of evaluation.checks) {
      expect(check.ok).toBe(false);
    }
  });

  it('checks array length equals expectedSignals length', () => {
    const scenario = getScenario('queue-backlog');
    expect(scenario).not.toBeNull();

    const evaluation = evaluateScenario(scenario!, makeFullReport());
    expect(evaluation.checks).toHaveLength(scenario!.expectedSignals.length);
    expect(evaluation.total).toBe(scenario!.expectedSignals.length);
  });
});

describe('evaluateScenario — key mapping', () => {
  it('seed key: ok when seeds is non-empty', () => {
    const scenario = getScenario('queue-backlog');
    expect(scenario).not.toBeNull();

    const report = makeEmptyReport();
    report.seeds = [makeSymbol('Foo')];
    const evaluation = evaluateScenario(scenario!, report);

    const seedCheck = evaluation.checks.find((c) => c.label === 'Seed symbols resolved');
    expect(seedCheck?.ok).toBe(true);
  });

  it('queue-boundary key: ok when boundaryCrossings is non-empty', () => {
    const scenario = getScenario('queue-backlog');
    expect(scenario).not.toBeNull();

    const report = makeEmptyReport();
    report.timeline.boundaryCrossings = [makeBoundaryCrossing()];
    const evaluation = evaluateScenario(scenario!, report);

    const bc = evaluation.checks.find((c) => c.label === 'Queue boundary crossing detected');
    expect(bc?.ok).toBe(true);
  });

  it('gaps key: ok when gapAnalysis.gaps is non-empty', () => {
    const scenario = getScenario('queue-backlog');
    expect(scenario).not.toBeNull();

    const report = makeEmptyReport();
    report.gapAnalysis.gaps = [makeGap()];
    const evaluation = evaluateScenario(scenario!, report);

    const gapsCheck = evaluation.checks.find((c) => c.label === 'Evidence gaps identified');
    expect(gapsCheck?.ok).toBe(true);
  });

  it('actions key: ok when nextActions is non-empty', () => {
    const scenario = getScenario('queue-backlog');
    expect(scenario).not.toBeNull();

    const report = makeEmptyReport();
    report.nextActions = ['Do something.'];
    const evaluation = evaluateScenario(scenario!, report);

    const actCheck = evaluation.checks.find((c) => c.label === 'Next actions generated');
    expect(actCheck?.ok).toBe(true);
  });

  it('hyp:<category> key: ok when hypothesis with matching category exists', () => {
    const scenario = getScenario('queue-backlog');
    expect(scenario).not.toBeNull();

    const report = makeEmptyReport();
    report.hypotheses = [makeHypothesis('queue-backlog')];
    const evaluation = evaluateScenario(scenario!, report);

    const hypCheck = evaluation.checks.find(
      (c) => c.label === 'queue-backlog hypothesis present',
    );
    expect(hypCheck?.ok).toBe(true);
  });

  it('unknown key maps to false', () => {
    // Mutate a scenario copy to inject an unknown key
    const base = getScenario('queue-backlog');
    expect(base).not.toBeNull();

    const scenario = {
      ...base!,
      expectedSignals: [{ key: 'totally-unknown-key', label: 'Unknown' }],
    };

    const report = makeFullReport();
    const evaluation = evaluateScenario(scenario, report);

    const unknownCheck = evaluation.checks[0];
    expect(unknownCheck?.ok).toBe(false);
    expect(evaluation.passed).toBe(0);
  });
});

describe('evaluateScenario — deployment-regression', () => {
  it('passes the commit check when commit evidence is present', () => {
    const scenario = getScenario('deployment-regression');
    expect(scenario).not.toBeNull();

    const report = makeFullReport();
    const evaluation = evaluateScenario(scenario!, report);

    const commitCheck = evaluation.checks.find((c) => c.label === 'Recent change evidence found');
    expect(commitCheck?.ok).toBe(true);
  });

  it('fails the commit check when no commit evidence is present', () => {
    const scenario = getScenario('deployment-regression');
    expect(scenario).not.toBeNull();

    const report = makeFullReport();
    report.evidence = [];
    const evaluation = evaluateScenario(scenario!, report);

    const commitCheck = evaluation.checks.find((c) => c.label === 'Recent change evidence found');
    expect(commitCheck?.ok).toBe(false);
  });
});

describe('renderSimulation', () => {
  it('shows a weak-investigation note when the score is below total', () => {
    const scenario = getScenario('queue-backlog')!;
    const report = makeEmptyReport();
    const evaluation = evaluateScenario(scenario, report);

    const output = renderSimulation(scenario, report, evaluation);
    expect(output).toContain('Weak investigation');
  });

  it('does not show a weak-investigation note when all checks pass', () => {
    const scenario = getScenario('queue-backlog')!;
    const report = makeFullReport();
    const evaluation = evaluateScenario(scenario, report);

    const output = renderSimulation(scenario, report, evaluation);
    expect(output).not.toContain('Weak investigation');
  });

  it('explains a missing queue boundary for queue scenarios', () => {
    const scenario = getScenario('queue-backlog')!;
    const report = makeEmptyReport();
    const evaluation = evaluateScenario(scenario, report);

    const output = renderSimulation(scenario, report, evaluation);
    expect(output).toContain('No queue boundary was detected');
  });

  it('explains missing commit evidence for deployment-regression scenarios', () => {
    const scenario = getScenario('deployment-regression')!;
    const report = makeEmptyReport();
    const evaluation = evaluateScenario(scenario, report);

    const output = renderSimulation(scenario, report, evaluation);
    expect(output).toContain('No recent change evidence was found');
  });
});
