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

  // 3. Diagnostic calibration (dogfood #5). Use the report's CALIBRATED confidence — which is
  // capped when the headline cause isn't structurally linked to the seed (#1/#2) — NOT the raw
  // max supported-hypothesis confidence. The old metric REWARDED a confident-but-wrong headline
  // (65%) and PUNISHED an honest "no dominant cause" run (a valid, competent outcome) with a 0,
  // i.e. it paid for manufacturing a headline. Calibrated confidence fixes both halves.
  const rootCauseValue = r.confidence;

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
      dimension: 'diagnostic calibration',
      value: rootCauseValue,
      weight: 0.25,
      note: 'calibrated confidence in the diagnosis — a seed-linked cause scores high; honest uncertainty is not punished',
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
