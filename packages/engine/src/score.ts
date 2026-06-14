/**
 * HOR-27 — Investigation quality scoring.
 *
 * Deterministic, pure scoring of an InvestigationReport. Measures Horus's
 * investigation quality, NOT the engineers being investigated.
 */

import type { InvestigationReport } from './types.js';

export interface ScoreComponent {
  dimension: string;
  value: number;
  weight: number;
  note: string;
}

export interface QualityScore {
  score: number;
  grade: string;
  components: ScoreComponent[];
  summary: string;
}

function toGrade(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function scoreInvestigation(r: InvestigationReport): QualityScore {
  // 1. Evidence support
  const evidenceValue = Math.min(1, r.evidence.length / 8);

  // 2. Hypothesis discrimination
  const total = r.hypotheses.length;
  const resolved = r.hypotheses.filter((h) => h.verdict !== 'unconfirmed').length;
  const discriminationValue = total > 0 ? resolved / total : 0;

  // 3. Root-cause confidence
  const supported = r.hypotheses.filter((h) => h.verdict === 'supported');
  const rootCauseValue =
    supported.length > 0
      ? Math.max(...supported.map((h) => h.confidence))
      : 0;

  // 4. Evidence completeness
  const completenessValue = 1 - Math.min(1, r.gapAnalysis.gaps.length / 6);

  // 5. Actionability
  const actionabilityValue = r.nextActions.length > 0 ? 1 : 0;

  const components: ScoreComponent[] = [
    {
      dimension: 'evidence support',
      value: evidenceValue,
      weight: 0.2,
      note: 'how much evidence was gathered',
    },
    {
      dimension: 'hypothesis discrimination',
      value: discriminationValue,
      weight: 0.25,
      note: 'fraction of hypotheses ruled in or out (vs left unconfirmed)',
    },
    {
      dimension: 'root-cause confidence',
      value: rootCauseValue,
      weight: 0.25,
      note: 'confidence in a supported root-cause candidate',
    },
    {
      dimension: 'evidence completeness',
      value: completenessValue,
      weight: 0.2,
      note: 'share of the needed evidence dimensions that were available',
    },
    {
      dimension: 'actionability',
      value: actionabilityValue,
      weight: 0.1,
      note: 'produced concrete next actions',
    },
  ];

  const score = Math.round(
    100 * components.reduce((acc, c) => acc + c.value * c.weight, 0),
  );

  const grade = toGrade(score);

  // Find the component with the lowest value as the biggest improvement lever
  let lowestComponent = components[0];
  for (const c of components) {
    if (lowestComponent === undefined || c.value < lowestComponent.value) {
      lowestComponent = c;
    }
  }

  const lowestDimension = lowestComponent?.dimension ?? 'unknown';
  const lowestNote = lowestComponent?.note ?? '';

  const summary =
    'Quality ' +
    score +
    '/100 (' +
    grade +
    '). Biggest lever: ' +
    lowestDimension +
    ' — ' +
    lowestNote +
    '. Measures Horus\'s investigation, not engineers.';

  return { score, grade, components, summary };
}
