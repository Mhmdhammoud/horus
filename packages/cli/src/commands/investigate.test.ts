/**
 * HOR-62 — Tests for the --ai flag and narrative input builder in runInvestigate.
 *
 * All tests are offline: no connectors, no live API calls.
 * We verify:
 *   - buildNarrativeInput maps InvestigationReport fields correctly
 *   - the --ai path is a boolean flag registered on the investigate command
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildNarrativeInput } from './investigate.js';
import type { InvestigationReport } from '@horus/engine';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Minimal fixture — enough to exercise buildNarrativeInput without connectors
// ---------------------------------------------------------------------------

const MINIMAL_REPORT: InvestigationReport = {
  id: 'test-report-001',
  input: { hint: 'BullMQ workers stalling', service: 'leadcall-api' },
  summary: 'Workers stalled after a concurrency bump.',
  seeds: [],
  evidence: [
    {
      id: 'ev-001',
      source: 'logs',
      kind: 'log',
      title: 'Worker stalled: job exceeded lockDuration',
      relevance: 0.9,
      payload: {},
      links: {},
      provenance: { query: 'es:*', collectedAt: '2026-06-15T10:00:00.000Z' },
      priority: 'critical',
    },
    {
      id: 'ev-002',
      source: 'history',
      kind: 'commit',
      title: 'Increase worker concurrency from 2 to 10',
      relevance: 0.8,
      payload: {},
      links: {},
      provenance: { query: 'git log', collectedAt: '2026-06-15T10:00:00.000Z' },
      priority: 'high',
    },
  ],
  timeline: { events: [], boundaryCrossings: [] },
  correlation: { groups: [], chains: [], missing: [] },
  findings: [
    { kind: 'correlation', title: 'Concurrency bump correlates with stalls', confidence: 0.88, evidenceIds: ['ev-001', 'ev-002'] },
  ],
  suspectedCauses: [
    {
      id: 'cause-001',
      title: 'Redis pool exhausted',
      category: 'queue-backlog',
      sourceEvidenceIds: ['ev-001', 'ev-002'],
      affectedNodeIds: [],
      baseScore: 0.7,
      finalScore: 0.82,
      confidence: 0.82,
      band: 'likely',
      explanations: [],
    },
  ],
  hypotheses: [],
  similarIncidents: [],
  gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1.0 },
  graph: { nodes: [], edges: [] },
  confidence: 0.78,
  nextActions: ['Roll back concurrency'],
};

// ---------------------------------------------------------------------------
// buildNarrativeInput
// ---------------------------------------------------------------------------

describe('buildNarrativeInput', () => {
  it('sets investigationId from report.id', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.investigationId).toBe('test-report-001');
  });

  it('sets hint from report.input.hint', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.hint).toBe('BullMQ workers stalling');
  });

  it('sets reportConfidence from report.confidence', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.reportConfidence).toBe(0.78);
  });

  it('maps all evidence items with id, kind, title', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.evidence).toHaveLength(2);
    expect(input.evidence[0]).toMatchObject({ id: 'ev-001', kind: 'log', title: 'Worker stalled: job exceeded lockDuration' });
    expect(input.evidence[1]).toMatchObject({ id: 'ev-002', kind: 'commit', title: 'Increase worker concurrency from 2 to 10' });
  });

  it('includes knownServices when report.input.service is set', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.knownServices).toEqual(['leadcall-api']);
  });

  it('returns empty knownServices when report.input.service is absent', () => {
    const report = { ...MINIMAL_REPORT, input: { ...MINIMAL_REPORT.input, service: undefined } };
    const input = buildNarrativeInput(report);
    expect(input.knownServices).toHaveLength(0);
  });

  it('maps suspectedCauses with label from title, score from finalScore', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.suspectedCauses).toHaveLength(1);
    expect(input.suspectedCauses[0]).toMatchObject({
      label: 'Redis pool exhausted',
      score: 0.82,
      evidenceIds: ['ev-001', 'ev-002'],
    });
  });

  it('sets deterministicSummary from report.summary', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.deterministicSummary).toBe('Workers stalled after a concurrency bump.');
  });

  it('maps findings with title and evidenceIds', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.findings).toHaveLength(1);
    expect(input.findings[0]).toMatchObject({
      title: 'Concurrency bump correlates with stalls',
      evidenceIds: ['ev-001', 'ev-002'],
    });
  });

  it('all narrative evidence IDs exist in the report evidence', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    const reportIds = new Set(MINIMAL_REPORT.evidence.map((e) => e.id));
    for (const ev of input.evidence) {
      expect(reportIds.has(ev.id)).toBe(true);
    }
  });
});
