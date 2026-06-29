/**
 * HOR-25 — Unit tests for validateHypotheses (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { Hypothesis } from './hypotheses.js';
import { validateHypotheses } from './validate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(id: string): Evidence {
  return {
    id,
    source: 'code',
    kind: 'symbol',
    title: `Test evidence ${id}`,
    relevance: 0.5,
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };
}

function makeHypothesis(overrides: Partial<Hypothesis> & { id: string }): Hypothesis {
  return {
    category: 'test',
    statement: 'Test hypothesis',
    confidence: 0.3,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Main tests
// ---------------------------------------------------------------------------

describe('validateHypotheses', () => {
  const presentEvidence: Evidence[] = [makeEvidence('e1')];

  // (a) Supporting evidence present — confidence rises, verdict 'supported'
  it('(a) supporting evidence present: verdict is supported and confidence > prior', () => {
    const hyp = makeHypothesis({
      id: 'h1',
      confidence: 0.3,
      supportingEvidenceIds: ['e1'],
      contradictingEvidenceIds: [],
      missingEvidence: [],
    });

    const result = validateHypotheses([hyp], presentEvidence);
    const vh = result[0];

    expect(vh).toBeDefined();
    expect(vh?.verdict).toBe('supported');
    expect(vh?.confidence).toBeGreaterThan(0.3);
    expect(vh?.priorConfidence).toBe(0.3);
    expect(vh?.supportingPresent).toBe(1);
    expect(vh?.contradictingPresent).toBe(0);
  });

  // (b) Contradicting evidence present — confidence falls, verdict 'weakened' or 'eliminated'
  it('(b) contradicting evidence present: confidence < prior and verdict weakened or eliminated', () => {
    const hyp = makeHypothesis({
      id: 'h2',
      confidence: 0.3,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: ['e1'],
      missingEvidence: [],
    });

    const result = validateHypotheses([hyp], presentEvidence);
    const vh = result[0];

    expect(vh).toBeDefined();
    expect(vh?.confidence).toBeLessThan(0.3);
    expect(vh?.priorConfidence).toBe(0.3);
    expect(vh?.contradictingPresent).toBe(1);
    expect(['weakened', 'eliminated']).toContain(vh?.verdict);
  });

  // (c) No supporting/contradicting, with missing evidence — verdict 'unconfirmed', confidence unchanged
  it('(c) no overlap with present evidence: verdict is unconfirmed and confidence equals prior', () => {
    const hyp = makeHypothesis({
      id: 'h3',
      confidence: 0.2,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: ['need X'],
    });

    const result = validateHypotheses([hyp], presentEvidence);
    const vh = result[0];

    expect(vh).toBeDefined();
    expect(vh?.verdict).toBe('unconfirmed');
    expect(vh?.confidence).toBe(0.2);
    expect(vh?.priorConfidence).toBe(0.2);
    expect(vh?.rationale).toContain('awaiting need X');
  });

  // Sorting: eliminated pushed to the end
  it('eliminated verdicts are sorted last regardless of original order', () => {
    // h_elim: contradicting present + very low prior → eliminated
    const hElim = makeHypothesis({
      id: 'h_elim',
      confidence: 0.05,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: ['e1'],
      missingEvidence: [],
    });

    // h_sup: supporting present → supported, higher final confidence
    const hSup = makeHypothesis({
      id: 'h_sup',
      confidence: 0.4,
      supportingEvidenceIds: ['e1'],
      contradictingEvidenceIds: [],
      missingEvidence: [],
    });

    // h_unconf: no overlap → unconfirmed
    const hUnconf = makeHypothesis({
      id: 'h_unconf',
      confidence: 0.2,
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: [],
    });

    // Pass in an order where eliminated is first
    const result = validateHypotheses([hElim, hSup, hUnconf], presentEvidence);

    const last = result[result.length - 1];
    expect(last).toBeDefined();
    expect(last?.verdict).toBe('eliminated');

    // The eliminated one should never appear before a non-eliminated one
    const firstNonElimIdx = result.findIndex((v) => v.verdict !== 'eliminated');
    const firstElimIdx = result.findIndex((v) => v.verdict === 'eliminated');
    if (firstNonElimIdx !== -1 && firstElimIdx !== -1) {
      expect(firstNonElimIdx).toBeLessThan(firstElimIdx);
    }
  });

  // Evidence ids not in the present set should not affect counts
  it('evidence ids not present are not counted', () => {
    const hyp = makeHypothesis({
      id: 'h_absent',
      confidence: 0.3,
      supportingEvidenceIds: ['absent-id-1', 'absent-id-2'],
      contradictingEvidenceIds: ['absent-id-3'],
      missingEvidence: [],
    });

    const result = validateHypotheses([hyp], presentEvidence);
    const vh = result[0];

    expect(vh).toBeDefined();
    expect(vh?.supportingPresent).toBe(0);
    expect(vh?.contradictingPresent).toBe(0);
    expect(vh?.verdict).toBe('unconfirmed');
    expect(vh?.confidence).toBe(0.3);
  });

  // ── HOR-435 lever #5: shared-evidence confidence calibration ───────────────

  it('(HOR-435) 2+ hypotheses sharing identical supporting evidence (nothing distinguishing) are capped at 0.75', () => {
    const shared = makeEvidence('shared');
    // Both would otherwise validate well above 0.75 (high prior + supporting boost).
    const h1 = makeHypothesis({
      id: 'h1',
      category: 'cause-a',
      confidence: 0.8,
      supportingEvidenceIds: ['shared'],
    });
    const h2 = makeHypothesis({
      id: 'h2',
      category: 'cause-b',
      confidence: 0.8,
      supportingEvidenceIds: ['shared'],
    });
    const result = validateHypotheses([h1, h2], [shared]);
    const v1 = result.find((v) => v.id === 'h1');
    const v2 = result.find((v) => v.id === 'h2');
    expect(v1!.confidence).toBeLessThanOrEqual(0.75);
    expect(v2!.confidence).toBeLessThanOrEqual(0.75);
    expect(v1!.confidence).toBe(0.75);
    expect(v1!.rationale.toLowerCase()).toContain('capped');
  });

  it('(HOR-435) a single hypothesis on that evidence is NOT capped (no red-herring cohort)', () => {
    const shared = makeEvidence('shared');
    const only = makeHypothesis({
      id: 'solo',
      confidence: 0.8,
      supportingEvidenceIds: ['shared'],
    });
    const [v] = validateHypotheses([only], [shared]);
    // 0.8 + 0.15 = 0.95, clamped — not pulled down to 0.75.
    expect(v!.confidence).toBeGreaterThan(0.75);
  });

  it('(HOR-435) hypotheses with DISTINCT supporting evidence are not capped (legitimately distinguished)', () => {
    const e1 = makeEvidence('e-distinct-1');
    const e2 = makeEvidence('e-distinct-2');
    const h1 = makeHypothesis({ id: 'd1', confidence: 0.8, supportingEvidenceIds: ['e-distinct-1'] });
    const h2 = makeHypothesis({ id: 'd2', confidence: 0.8, supportingEvidenceIds: ['e-distinct-2'] });
    const result = validateHypotheses([h1, h2], [e1, e2]);
    expect(result.find((v) => v.id === 'd1')!.confidence).toBeGreaterThan(0.75);
    expect(result.find((v) => v.id === 'd2')!.confidence).toBeGreaterThan(0.75);
  });

  it('(HOR-435) a cohort where one member has contradicting evidence is not treated as a pure-correlation red herring', () => {
    const shared = makeEvidence('shared');
    const contra = makeEvidence('contra');
    // h2 is weakened by contradicting evidence, so it is excluded from the cohort; h1 is then
    // alone on the shared-evidence key and is NOT capped.
    const h1 = makeHypothesis({ id: 'c1', confidence: 0.8, supportingEvidenceIds: ['shared'] });
    const h2 = makeHypothesis({
      id: 'c2',
      confidence: 0.8,
      supportingEvidenceIds: ['shared'],
      contradictingEvidenceIds: ['contra'],
    });
    const result = validateHypotheses([h1, h2], [shared, contra]);
    expect(result.find((v) => v.id === 'c1')!.confidence).toBeGreaterThan(0.75);
  });

  // Rationale always ends with a period
  it('rationale is a non-empty sentence ending with a period', () => {
    const hyp = makeHypothesis({ id: 'h_rat', supportingEvidenceIds: ['e1'] });
    const result = validateHypotheses([hyp], presentEvidence);
    const vh = result[0];
    expect(vh?.rationale.endsWith('.')).toBe(true);
    expect((vh?.rationale.length ?? 0)).toBeGreaterThan(0);
  });
});
