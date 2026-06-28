/**
 * Stage 0 — additive guard for the evidence-subject + FindingKind work.
 *
 * The contract: `Evidence.subject`, `InvestigationReport.subject`, and the
 * `FindingKind` typing are ADDITIVE — they must never enter the deterministic
 * scoring / confidence / verdict path. These tests assert that the three pure
 * engine kernels (rankCauses, computeWeightedEvidenceConfidence,
 * validateHypotheses) produce BYTE-IDENTICAL outputs whether or not a subject
 * has been stamped onto the evidence, and that the FindingKind enum is locked
 * to the values the engine actually emits.
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import { normalizeEvidence } from './normalize.js';
import { rankCauses, type CauseInput, type ScoringContext } from './score-cause.js';
import { computeWeightedEvidenceConfidence } from './confidence.js';
import { validateHypotheses } from './validate.js';
import type { Hypothesis } from './hypotheses.js';
import type { FindingKind, ReportFinding } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEv(
  overrides: Partial<Evidence> & Pick<Evidence, 'id' | 'source' | 'kind' | 'relevance'>,
): Evidence {
  return {
    title: 'test evidence',
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: '2026-06-14T12:00:00Z' },
    ...overrides,
  };
}

function baseEvidence(): Evidence[] {
  return normalizeEvidence([
    makeEv({ id: 'ev-log-1', source: 'logs', kind: 'log', relevance: 0.95 }),
    makeEv({ id: 'ev-metric-1', source: 'metrics', kind: 'metric', relevance: 0.8 }),
    makeEv({ id: 'ev-commit-1', source: 'history', kind: 'commit', relevance: 0.85 }),
    makeEv({ id: 'ev-symbol-1', source: 'code', kind: 'symbol', relevance: 0.9 }),
    makeEv({ id: 'ev-state-1', source: 'state', kind: 'state', relevance: 0.85 }),
  ]);
}

function causeInputs(): CauseInput[] {
  return [
    {
      id: 'cause-a',
      title: 'Deployment regression',
      category: 'deployment',
      sourceEvidenceIds: ['ev-commit-1', 'ev-log-1'],
      baseScore: 0.6,
    },
    {
      id: 'cause-b',
      title: 'State anomaly',
      category: 'database',
      sourceEvidenceIds: ['ev-state-1', 'ev-metric-1'],
      baseScore: 0.4,
    },
  ];
}

function findings(): ReportFinding[] {
  return [
    { kind: 'observation', title: 'seed resolved', confidence: 0.8, evidenceIds: ['ev-symbol-1'] },
    { kind: 'anomaly', title: 'error spike', confidence: 0.9, evidenceIds: ['ev-log-1'] },
    { kind: 'correlation', title: 'commit ↔ errors', confidence: 0.7, evidenceIds: ['ev-commit-1', 'ev-log-1'] },
  ];
}

function hypotheses(): Hypothesis[] {
  return [
    {
      id: 'hyp-1',
      category: 'deployment',
      statement: 'A recent deploy introduced the fault',
      confidence: 0.5,
      supportingEvidenceIds: ['ev-commit-1', 'ev-log-1'],
      contradictingEvidenceIds: [],
      missingEvidence: [],
    },
    {
      id: 'hyp-2',
      category: 'state',
      statement: 'Stale state caused the anomaly',
      confidence: 0.4,
      supportingEvidenceIds: ['ev-state-1'],
      contradictingEvidenceIds: ['ev-metric-1'],
      missingEvidence: [],
    },
  ];
}

const NOW = '2026-06-20T00:00:00Z';

function scoringCtx(evidence: Evidence[]): ScoringContext {
  return {
    evidence,
    graph: { nodes: [], edges: [] },
    findings: findings(),
    request: { hint: 'OrderService', service: 'orders' },
    now: NOW,
  };
}

// ---------------------------------------------------------------------------
// FindingKind typing
// ---------------------------------------------------------------------------

describe('FindingKind — typing', () => {
  it('accepts exactly the values the engine emits', () => {
    const kinds: FindingKind[] = ['observation', 'anomaly', 'correlation'];
    for (const kind of kinds) {
      const finding: ReportFinding = { kind, title: 't', confidence: 0.5, evidenceIds: [] };
      expect(finding.kind).toBe(kind);
    }
  });

  it('rejects a kind outside the enum at compile time', () => {
    // @ts-expect-error 'mystery' is not a FindingKind — the enum is closed.
    const bad: ReportFinding = { kind: 'mystery', title: 't', confidence: 0.5, evidenceIds: [] };
    expect(bad.title).toBe('t');
  });
});

// ---------------------------------------------------------------------------
// No-regression guard: subject never enters the scoring/confidence/verdict path
// ---------------------------------------------------------------------------

describe('Stage 0 — subject is inert to scoring/confidence/verdict', () => {
  it('rankCauses is byte-identical with and without a stamped subject', () => {
    const withoutSubject = baseEvidence();
    const withSubject = normalizeEvidence(baseEvidence(), {
      service: 'orders',
      environment: 'production',
    });

    // Sanity: the subject WAS stamped on the second set (and not the first).
    expect(withSubject.every((e) => e.subject?.service === 'orders')).toBe(true);
    expect(withoutSubject.every((e) => e.subject === undefined)).toBe(true);

    const a = rankCauses(causeInputs(), scoringCtx(withoutSubject), 3);
    const b = rankCauses(causeInputs(), scoringCtx(withSubject), 3);
    expect(b).toEqual(a);
  });

  it('computeWeightedEvidenceConfidence is byte-identical with and without a subject', () => {
    const withoutSubject = baseEvidence();
    const withSubject = normalizeEvidence(baseEvidence(), {
      service: 'orders',
      environment: 'production',
    });
    expect(computeWeightedEvidenceConfidence(withSubject)).toBe(
      computeWeightedEvidenceConfidence(withoutSubject),
    );
  });

  it('validateHypotheses verdicts/confidence are byte-identical with and without a subject', () => {
    const withoutSubject = baseEvidence();
    const withSubject = normalizeEvidence(baseEvidence(), {
      service: 'orders',
      environment: 'production',
    });
    const a = validateHypotheses(hypotheses(), withoutSubject);
    const b = validateHypotheses(hypotheses(), withSubject);
    expect(b).toEqual(a);
  });
});
