/**
 * HOR-204 — Deterministic investigation Q&A.
 */
import { describe, it, expect } from 'vitest';
import { detectQuestion, answerQuestion } from './qa.js';
import type { InvestigationReport } from './types.js';

function makeReport(over: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    id: 'inv-1',
    input: { hint: 'getSaleWithLink slow' },
    summary: '',
    seeds: [],
    evidence: [
      { id: 'ev-contra-1', source: 'logs', kind: 'log', title: 'low retry rate observed', relevance: 0.5, payload: {}, links: {}, provenance: { query: 'q', collectedAt: 'now' } },
      { id: 'ev-sup-1', source: 'queue', kind: 'queue-state', title: 'backlog growing', relevance: 0.8, payload: {}, links: {}, provenance: { query: 'q', collectedAt: 'now' } },
    ],
    timeline: { events: [] } as never,
    correlation: {} as never,
    findings: [],
    suspectedCauses: [],
    hypotheses: [
      {
        id: 'h-retry',
        category: 'retry-storm',
        statement: 'A retry storm is amplifying load',
        confidence: 0.6,
        supportingEvidenceIds: ['ev-sup-1'],
        contradictingEvidenceIds: ['ev-contra-1'],
        missingEvidence: ['Request latency metrics'],
        verdict: 'weakened',
        priorConfidence: 0.6,
        supportingPresent: 1,
        contradictingPresent: 1,
        rationale: '1 supporting / 1 contradicting evidence present.',
      },
    ],
    similarIncidents: [],
    gapAnalysis: {
      gaps: [
        { dimension: 'deployment records', why: 'No deployment data in scope.', nextSource: 'Re-run with --since', confidenceImpact: 0.08 },
        { dimension: 'traces', why: 'No distributed traces.', nextSource: 'Add tracing', confidenceImpact: 0.07 },
      ],
      blindSpots: ['Cannot correlate with a recent change.'],
      confidenceCeiling: 0.85,
    },
    graph: {} as never,
    confidence: 0.68,
    nextActions: [],
    ...over,
  } as InvestigationReport;
}

describe('detectQuestion', () => {
  it('classifies the three supported questions', () => {
    expect(detectQuestion('what evidence contradicts retry storm?')).toBe('contradicts');
    expect(detectQuestion('what evidence is missing?')).toBe('missing-evidence');
    expect(detectQuestion('why is confidence not higher?')).toBe('confidence');
  });

  it('returns null for a topic-filter directive (so the caller falls back)', () => {
    expect(detectQuestion('focus on queue')).toBeNull();
    expect(detectQuestion('queue')).toBeNull();
    expect(detectQuestion('ignore deployment')).toBeNull();
  });
});

describe('answerQuestion', () => {
  it('contradicts: returns the matched hypothesis contradicting evidence', () => {
    const a = answerQuestion(makeReport(), 'what evidence contradicts retry storm?');
    expect(a?.kind).toBe('contradicts');
    expect(a?.evidence.map((e) => e.id)).toEqual(['ev-contra-1']);
    expect(a?.headline).toMatch(/contradict/i);
  });

  it('contradicts: clearly says none found when there is no contradicting evidence', () => {
    const r = makeReport();
    r.hypotheses[0]!.contradictingEvidenceIds = [];
    const a = answerQuestion(r, 'what contradicts retry storm?');
    expect(a?.evidence).toHaveLength(0);
    expect(a?.headline).toMatch(/no evidence contradicts/i);
  });

  it('contradicts: says topic was not evaluated when no hypothesis matches', () => {
    const a = answerQuestion(makeReport(), 'what evidence contradicts deployment?');
    expect(a?.headline).toMatch(/not among the evaluated hypotheses/i);
  });

  it('missing-evidence: returns the gaps section', () => {
    const a = answerQuestion(makeReport(), 'what evidence is missing?');
    expect(a?.kind).toBe('missing-evidence');
    expect(a?.headline).toMatch(/2 evidence gap/);
    expect(a?.details.join('\n')).toMatch(/deployment records/);
    expect(a?.details.join('\n')).toMatch(/traces/);
  });

  it('confidence: returns ceiling, limiting factors, and weak hypotheses', () => {
    const a = answerQuestion(makeReport(), 'why is confidence not higher?');
    expect(a?.kind).toBe('confidence');
    expect(a?.headline).toMatch(/68%/);
    expect(a?.headline).toMatch(/85%/);
    expect(a?.details.join('\n')).toMatch(/deployment records.*−8%/);
    expect(a?.details.join('\n')).toMatch(/retry-storm \(weakened\)/);
  });

  it('returns null for a non-question directive', () => {
    expect(answerQuestion(makeReport(), 'focus on queue')).toBeNull();
  });
});
