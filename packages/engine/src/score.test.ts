/**
 * HOR-27 — Unit tests for scoreInvestigation (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import { scoreInvestigation } from './score.js';
import type { InvestigationReport } from './types.js';
import type { ValidatedHypothesis } from './validate.js';
import type { Evidence } from '@horus/core';
import type { GapAnalysis } from './gaps.js';
import type { Timeline } from './timeline.js';
import type { CorrelationResult } from './correlate.js';

// ---------------------------------------------------------------------------
// Minimal stub builders
// ---------------------------------------------------------------------------

function makeEvidence(n: number): Evidence[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 'ev-' + i,
    kind: 'log' as const,
    source: 'logs' as const,
    title: 'Evidence ' + i,
    relevance: 0.8,
    payload: null,
    links: {},
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  }));
}

function makeHypothesis(
  id: string,
  verdict: ValidatedHypothesis['verdict'],
  confidence: number,
): ValidatedHypothesis {
  return {
    id,
    category: 'test-category',
    statement: 'Hypothesis ' + id,
    confidence,
    priorConfidence: confidence,
    verdict,
    supportingPresent: verdict === 'supported' ? 1 : 0,
    contradictingPresent: verdict === 'eliminated' || verdict === 'weakened' ? 1 : 0,
    rationale: 'test rationale',
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
  };
}

function makeGapAnalysis(gapCount: number): GapAnalysis {
  return {
    gaps: Array.from({ length: gapCount }, (_, i) => ({
      dimension: 'gap-' + i,
      why: 'Missing dimension ' + i,
      nextSource: 'Some provider',
      confidenceImpact: 0.05,
    })),
    blindSpots: Array.from({ length: gapCount }, (_, i) => 'Blind spot ' + i),
    confidenceCeiling: Math.max(0.3, 1 - gapCount * 0.05),
  };
}

const emptyTimeline: Timeline = { events: [], boundaryCrossings: [] };

const emptyCorrelation: CorrelationResult = {
  groups: [],
  chains: [],
  missing: [],
};

function makeReport(overrides: Partial<InvestigationReport>): InvestigationReport {
  return {
    id: 'report-test',
    input: { hint: 'test hint' },
    summary: 'Test summary',
    seeds: [],
    evidence: [],
    timeline: emptyTimeline,
    correlation: emptyCorrelation,
    findings: [],
    suspectedCauses: [],
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: makeGapAnalysis(0),
    confidence: 0.5,
    nextActions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('scoreInvestigation', () => {
  it('returns a high score for a rich investigation (>= 55, valid grade)', () => {
    // 8 evidence pieces → evidence support = 1.0
    // 3 of 6 hypotheses resolved (2 supported + 1 eliminated, 3 unconfirmed) → discrimination = 3/6 = 0.5
    // supported hypothesis at 0.7 → root-cause confidence = 0.7
    // 1 gap → completeness = 1 - 1/6 ≈ 0.833
    // has next actions → actionability = 1.0
    const report = makeReport({
      evidence: makeEvidence(8),
      hypotheses: [
        makeHypothesis('h1', 'supported', 0.7),
        makeHypothesis('h2', 'supported', 0.5),
        makeHypothesis('h3', 'eliminated', 0.05),
        makeHypothesis('h4', 'unconfirmed', 0.3),
        makeHypothesis('h5', 'unconfirmed', 0.2),
        makeHypothesis('h6', 'unconfirmed', 0.1),
      ],
      gapAnalysis: makeGapAnalysis(1),
      nextActions: ['Check the logs', 'Contact the team', 'Deploy a fix'],
    });

    const result = scoreInvestigation(report);

    expect(result.score).toBeGreaterThanOrEqual(55);
    expect(['A', 'B', 'C', 'D', 'F']).toContain(result.grade);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.components).toHaveLength(5);
    for (const c of result.components) {
      expect(c.value).toBeGreaterThanOrEqual(0);
      expect(c.value).toBeLessThanOrEqual(1);
    }
  });

  it('returns a low score for a sparse investigation (< 40, grade F)', () => {
    // 1 evidence → evidence support = 1/8 ≈ 0.125
    // 6 hypotheses all unconfirmed → discrimination = 0
    // no supported hypothesis → root-cause confidence = 0
    // 6 gaps → completeness = 1 - 6/6 = 0
    // no next actions → actionability = 0
    const report = makeReport({
      evidence: makeEvidence(1),
      hypotheses: [
        makeHypothesis('h1', 'unconfirmed', 0.3),
        makeHypothesis('h2', 'unconfirmed', 0.3),
        makeHypothesis('h3', 'unconfirmed', 0.3),
        makeHypothesis('h4', 'unconfirmed', 0.3),
        makeHypothesis('h5', 'unconfirmed', 0.3),
        makeHypothesis('h6', 'unconfirmed', 0.3),
      ],
      gapAnalysis: makeGapAnalysis(6),
      nextActions: [],
    });

    const result = scoreInvestigation(report);

    expect(result.score).toBeLessThan(40);
    expect(result.grade).toBe('F');
    // summary mentions the lowest lever
    expect(result.summary.toLowerCase()).toMatch(/biggest lever/);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.components).toHaveLength(5);
    for (const c of result.components) {
      expect(c.value).toBeGreaterThanOrEqual(0);
      expect(c.value).toBeLessThanOrEqual(1);
    }
  });

  it('mentions "not engineers" in the summary', () => {
    const report = makeReport({});
    const result = scoreInvestigation(report);
    expect(result.summary).toMatch(/not engineers/i);
  });

  it('returns score in [0, 100] for an empty report', () => {
    const report = makeReport({});
    const result = scoreInvestigation(report);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.components).toHaveLength(5);
  });
});
