/**
 * HOR-204 — Deterministic investigation Q&A.
 *
 * Answers common follow-up questions directly from a persisted InvestigationReport,
 * without re-querying any connector or invoking an LLM:
 *   - "what evidence contradicts <topic>?"  → that hypothesis's contradicting evidence
 *   - "what evidence is missing?"            → the evidence-gaps section
 *   - "why is confidence not higher?"        → ceiling + limiting gaps + weak hypotheses
 *
 * When the text is not a recognized question, `answerQuestion` returns null and the
 * caller falls back to deterministic topic filtering (refineInvestigation).
 */

import type { Evidence } from '@horus/core';
import type { InvestigationReport } from './types.js';
import { TOPIC_MAP } from './refine.js';

export type QAKind = 'contradicts' | 'missing-evidence' | 'confidence';

export interface QAAnswer {
  question: string;
  kind: QAKind;
  /** One-line direct answer. */
  headline: string;
  /** Supporting detail lines (gaps, factors, hypothesis verdicts). */
  details: string[];
  /** Evidence items that back the answer (e.g. the contradicting items). */
  evidence: Evidence[];
}

const CONTRADICTS_RE = /\b(contradict|contradicts|argues?\s+against|evidence\s+against|rule\s+out|disprove|refute|weaken)\b/i;
const MISSING_RE = /\b(missing|absent|gaps?|don'?t\s+have|do\s+not\s+have|lack(?:ing)?|what\s+else)\b/i;
const CONFIDENCE_RE = /\b(confidence|confident|certainty|sure|why\s+(?:is\s+)?(?:it\s+)?not\s+higher)\b/i;

/** Classify free text as one of the supported questions, or null if it isn't one. */
export function detectQuestion(text: string): QAKind | null {
  const t = text.toLowerCase();
  // Confidence and contradiction are more specific than the broad "missing" verbs,
  // so test them first to avoid a generic "gap" word stealing a confidence question.
  if (CONFIDENCE_RE.test(t)) return 'confidence';
  if (CONTRADICTS_RE.test(t)) return 'contradicts';
  if (MISSING_RE.test(t)) return 'missing-evidence';
  return null;
}

/** Map a topic phrase to known cause/hypothesis categories via the shared topic map. */
function categoriesForTopic(text: string): { topic: string; categories: string[] } | null {
  const t = text.toLowerCase();
  for (const [topic, entry] of Object.entries(TOPIC_MAP)) {
    if (topic === t.trim()) return { topic, categories: entry.categories };
    if (entry.keywords.some((kw) => new RegExp(`\\b${kw}\\b`).test(t))) {
      return { topic, categories: entry.categories };
    }
  }
  return null;
}

function evidenceById(report: InvestigationReport): Map<string, Evidence> {
  return new Map(report.evidence.map((e) => [e.id, e]));
}

function answerContradicts(report: InvestigationReport, question: string): QAAnswer {
  const matched = categoriesForTopic(question);
  const byId = evidenceById(report);

  // Find the hypothesis/cause whose category matches the topic.
  const hyps = matched
    ? report.hypotheses.filter((h) => matched.categories.includes(h.category))
    : [];

  if (matched && hyps.length === 0) {
    const evaluated = [...new Set(report.hypotheses.map((h) => h.category))];
    return {
      question,
      kind: 'contradicts',
      headline: `"${matched.topic}" was not among the evaluated hypotheses — no evidence supports it.`,
      details:
        evaluated.length > 0
          ? [`Hypotheses evaluated: ${evaluated.join(', ')}.`]
          : ['No hypotheses were formed for this investigation.'],
      evidence: [],
    };
  }

  if (hyps.length === 0) {
    // No topic recognized — report contradicting evidence across all hypotheses.
    const ids = [...new Set(report.hypotheses.flatMap((h) => h.contradictingEvidenceIds))];
    const ev = ids.map((id) => byId.get(id)).filter((e): e is Evidence => e !== undefined);
    return {
      question,
      kind: 'contradicts',
      headline:
        ev.length > 0
          ? `${ev.length} item(s) contradict the leading hypotheses.`
          : 'No contradicting evidence was recorded for any hypothesis.',
      details: ev.length > 0 ? [] : ['Evidence either supports or is neutral to the hypotheses.'],
      evidence: ev,
    };
  }

  const ids = [...new Set(hyps.flatMap((h) => h.contradictingEvidenceIds))];
  const ev = ids.map((id) => byId.get(id)).filter((e): e is Evidence => e !== undefined);
  const verdicts = [...new Set(hyps.map((h) => h.verdict))].join(', ');
  if (ev.length === 0) {
    return {
      question,
      kind: 'contradicts',
      headline: `No evidence contradicts "${matched?.topic ?? 'this'}" (verdict: ${verdicts}).`,
      details: hyps.map((h) => `${h.category}: ${h.rationale ?? h.statement}`),
      evidence: [],
    };
  }
  return {
    question,
    kind: 'contradicts',
    headline: `${ev.length} item(s) contradict "${matched?.topic ?? 'this'}" (verdict: ${verdicts}).`,
    details: hyps.map((h) => `${h.category}: ${h.rationale ?? h.statement}`),
    evidence: ev,
  };
}

function answerMissing(report: InvestigationReport, question: string): QAAnswer {
  const { gaps, blindSpots } = report.gapAnalysis;
  const hypMissing = [...new Set(report.hypotheses.flatMap((h) => h.missingEvidence))];
  if (gaps.length === 0 && hypMissing.length === 0) {
    return {
      question,
      kind: 'missing-evidence',
      headline: 'No evidence gaps — all expected dimensions were collected.',
      details: [],
      evidence: [],
    };
  }
  const details = gaps.map(
    (g) => `${g.dimension}: ${g.why} → ${g.nextSource} (−${(g.confidenceImpact * 100).toFixed(0)}% ceiling)`,
  );
  if (hypMissing.length > 0) {
    details.push(`To confirm hypotheses: ${hypMissing.join('; ')}.`);
  }
  for (const bs of blindSpots) details.push(`Blind spot: ${bs}`);
  return {
    question,
    kind: 'missing-evidence',
    headline: `${gaps.length} evidence gap(s) limit this investigation.`,
    details,
    evidence: [],
  };
}

function answerConfidence(report: InvestigationReport, question: string): QAAnswer {
  const { gaps, confidenceCeiling } = report.gapAnalysis;
  const ceilingPct = Math.round(confidenceCeiling * 100);
  const actualPct = Math.round(report.confidence * 100);
  // Limiting factors = gaps ordered by how much each shaves off the ceiling.
  const limiting = [...gaps].sort((a, b) => b.confidenceImpact - a.confidenceImpact);
  const details: string[] = [];
  if (limiting.length > 0) {
    details.push(`Confidence is capped at ${ceilingPct}% by missing evidence:`);
    for (const g of limiting) {
      details.push(`  • ${g.dimension} (−${(g.confidenceImpact * 100).toFixed(0)}%): ${g.why}`);
    }
  } else {
    details.push('No evidence gaps cap the ceiling.');
  }
  const weak = report.hypotheses.filter((h) => h.verdict === 'weakened' || h.verdict === 'unconfirmed');
  if (weak.length > 0) {
    details.push(
      `Unconfirmed/weakened hypotheses: ${weak.map((h) => `${h.category} (${h.verdict})`).join(', ')}.`,
    );
  }
  return {
    question,
    kind: 'confidence',
    headline: `Confidence is ${actualPct}% (ceiling ${ceilingPct}%). ${
      limiting.length > 0 ? 'Missing evidence is the main limiter.' : 'Limited by hypothesis support, not gaps.'
    }`,
    details,
    evidence: [],
  };
}

/**
 * Answer a follow-up question from the report, or return null when the text is not a
 * recognized question (the caller then falls back to topic filtering).
 */
export function answerQuestion(report: InvestigationReport, question: string): QAAnswer | null {
  const kind = detectQuestion(question);
  if (kind === null) return null;
  if (kind === 'contradicts') return answerContradicts(report, question);
  if (kind === 'missing-evidence') return answerMissing(report, question);
  return answerConfidence(report, question);
}

// ---------------------------------------------------------------------------
// Renderers (plain strings — the CLI applies color)
// ---------------------------------------------------------------------------

/** Render a Q&A answer as a terminal-friendly text block. */
export function renderQAAnswer(a: QAAnswer): string {
  const lines: string[] = [];
  lines.push(`Q: ${a.question}`);
  lines.push('');
  lines.push(a.headline);
  for (const d of a.details) lines.push(d.startsWith('  ') ? d : `  ${d}`);
  if (a.evidence.length > 0) {
    lines.push('');
    lines.push('Evidence:');
    for (const e of a.evidence) {
      lines.push(`  [${e.id.slice(0, 8)}] (${e.kind}) ${e.title}`);
    }
  }
  return lines.join('\n');
}

/** Render a Q&A answer as JSON. */
export function qaToJSON(a: QAAnswer): string {
  return JSON.stringify(
    {
      question: a.question,
      kind: a.kind,
      headline: a.headline,
      details: a.details,
      evidence: a.evidence.map((e) => ({ id: e.id, kind: e.kind, title: e.title })),
    },
    null,
    2,
  );
}
