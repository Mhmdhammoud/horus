/**
 * HOR-15 review — Unit tests for migrateReport().
 * Pure, no I/O. Guards the legacy SuspectedCause → CauseCandidate migration.
 */

import { describe, it, expect } from 'vitest';
import { migrateReport } from './migrate-report.js';

// ---------------------------------------------------------------------------
// Minimal objects for constructing test inputs
// ---------------------------------------------------------------------------

function legacyCause(statement: string, score: number, evidenceIds: string[]) {
  return { statement, score, evidenceIds };
}

function newCause(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cause:test',
    title: 'Test cause',
    category: 'other',
    sourceEvidenceIds: [],
    affectedNodeIds: [],
    baseScore: 0.45,
    finalScore: 0.60,
    confidence: 0.60,
    band: 'possible',
    explanations: [],
    ...overrides,
  };
}

function makeReport(suspectedCauses: unknown[]) {
  return {
    id: 'inv-001',
    input: { hint: 'test' },
    summary: 'Test',
    seeds: [],
    evidence: [],
    timeline: { events: [], boundaryCrossings: [] },
    correlation: { groups: [], chains: [], missing: [] },
    findings: [],
    suspectedCauses,
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
    graph: { nodes: [], edges: [] },
    confidence: 0.5,
    nextActions: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateReport — legacy SuspectedCause shape', () => {
  it('promotes statement → title', () => {
    const raw = makeReport([legacyCause('Connection pool exhaustion.', 0.70, [])]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.title).toBe('Connection pool exhaustion.');
  });

  it('promotes score → finalScore and confidence', () => {
    const raw = makeReport([legacyCause('Some cause', 0.72, [])]);
    const report = migrateReport(raw);
    const c = report.suspectedCauses[0]!;
    expect(c.finalScore).toBe(0.72);
    expect(c.confidence).toBe(0.72);
    expect(c.baseScore).toBe(0.72);
  });

  it('promotes evidenceIds → sourceEvidenceIds', () => {
    const raw = makeReport([legacyCause('Some cause', 0.60, ['ev-001', 'ev-002'])]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.sourceEvidenceIds).toEqual(['ev-001', 'ev-002']);
  });

  it('assigns a legacy id based on array index', () => {
    const raw = makeReport([
      legacyCause('First', 0.60, []),
      legacyCause('Second', 0.50, []),
    ]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.id).toBe('cause:legacy:0');
    expect(report.suspectedCauses[1]?.id).toBe('cause:legacy:1');
  });

  it('assigns a score-derived band', () => {
    const cases: [number, string][] = [
      [0.90, 'highly-likely'],
      [0.70, 'likely'],
      [0.50, 'possible'],
      [0.30, 'observation'],
    ];
    for (const [score, expectedBand] of cases) {
      const raw = makeReport([legacyCause('Some cause', score, [])]);
      const report = migrateReport(raw);
      expect(report.suspectedCauses[0]?.band).toBe(expectedBand);
    }
  });

  it('sets affectedNodeIds to an empty array', () => {
    const raw = makeReport([legacyCause('Some cause', 0.60, [])]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.affectedNodeIds).toEqual([]);
  });

  it('sets explanations to an empty array', () => {
    const raw = makeReport([legacyCause('Some cause', 0.60, [])]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.explanations).toEqual([]);
  });
});

describe('migrateReport — current CauseCandidate shape (idempotent)', () => {
  it('passes through a current-shape cause unchanged', () => {
    const cause = newCause();
    const raw = makeReport([cause]);
    const report = migrateReport(raw);
    const c = report.suspectedCauses[0]!;
    expect(c.id).toBe('cause:test');
    expect(c.title).toBe('Test cause');
    expect(c.finalScore).toBe(0.60);
    expect(c.sourceEvidenceIds).toEqual([]);
  });

  it('calling migrateReport twice produces the same result', () => {
    const cause = newCause({ finalScore: 0.75, title: 'Stable cause' });
    const raw = makeReport([cause]);
    const once = migrateReport(raw);
    const twice = migrateReport(once);
    expect(twice.suspectedCauses[0]?.title).toBe('Stable cause');
    expect(twice.suspectedCauses[0]?.finalScore).toBe(0.75);
  });

  it('returns all non-suspectedCauses fields verbatim', () => {
    const raw = makeReport([]);
    (raw as Record<string, unknown>)['confidence'] = 0.88;
    const report = migrateReport(raw);
    expect(report.confidence).toBe(0.88);
  });
});

describe('migrateReport — mixed report (legacy + current causes)', () => {
  it('migrates legacy causes and leaves current-shape causes untouched', () => {
    const raw = makeReport([
      legacyCause('Legacy cause.', 0.60, ['ev-001']),
      newCause({ title: 'New cause', finalScore: 0.80 }),
    ]);
    const report = migrateReport(raw);
    const legacy = report.suspectedCauses[0]!;
    const current = report.suspectedCauses[1]!;
    expect(legacy.title).toBe('Legacy cause.');
    expect(legacy.id).toBe('cause:legacy:0');
    expect(current.title).toBe('New cause');
    expect(current.id).toBe('cause:test');
  });
});

describe('migrateReport — malformed input', () => {
  it('throws for null', () => {
    expect(() => migrateReport(null)).toThrow();
  });

  it('throws for a primitive string', () => {
    expect(() => migrateReport('not an object')).toThrow();
  });

  it('handles an empty suspectedCauses array', () => {
    const raw = makeReport([]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses).toHaveLength(0);
  });

  it('handles a non-array suspectedCauses (no crash, passes through)', () => {
    const raw = { ...makeReport([]), suspectedCauses: 'bad' };
    expect(() => migrateReport(raw)).not.toThrow();
  });

  it('filters null entries from suspectedCauses so renderers cannot fail on them', () => {
    const raw = makeReport([null, legacyCause('Valid cause', 0.60, [])]);
    const report = migrateReport(raw);
    // null was dropped; only the valid cause survives
    expect(report.suspectedCauses).toHaveLength(1);
    expect(report.suspectedCauses[0]?.title).toBe('Valid cause');
  });

  it('filters {} — no statement means no diagnostic value', () => {
    const raw = makeReport([{}, legacyCause('Real cause', 0.55, [])]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses).toHaveLength(1);
    expect(report.suspectedCauses[0]?.title).toBe('Real cause');
  });
});

describe('migrateReport — partial current-shape causes (field defaults)', () => {
  it('fills sourceEvidenceIds with [] when missing', () => {
    const raw = makeReport([{ title: 'Partial', finalScore: 0.70 }]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.sourceEvidenceIds).toEqual([]);
  });

  it('fills affectedNodeIds with [] when missing', () => {
    const raw = makeReport([{ title: 'Partial', finalScore: 0.70 }]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.affectedNodeIds).toEqual([]);
  });

  it('fills explanations with [] when missing', () => {
    const raw = makeReport([{ title: 'Partial', finalScore: 0.70 }]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.explanations).toEqual([]);
  });

  it('fills id with cause:partial:N when missing', () => {
    const raw = makeReport([{ title: 'Partial', finalScore: 0.70 }]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.id).toBe('cause:partial:0');
  });

  it('fills band from finalScore when missing', () => {
    const raw = makeReport([{ title: 'Partial', finalScore: 0.70 }]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.band).toBe('likely');
  });

  it('fills category with "unknown" when missing', () => {
    const raw = makeReport([{ title: 'Partial', finalScore: 0.70 }]);
    const report = migrateReport(raw);
    expect(report.suspectedCauses[0]?.category).toBe('unknown');
  });

  it('preserves fields that are already present', () => {
    const raw = makeReport([{
      id: 'cause:abc',
      title: 'Partial',
      finalScore: 0.70,
      sourceEvidenceIds: ['ev-1'],
    }]);
    const report = migrateReport(raw);
    const c = report.suspectedCauses[0]!;
    expect(c.id).toBe('cause:abc');
    expect(c.sourceEvidenceIds).toEqual(['ev-1']);
  });
});
