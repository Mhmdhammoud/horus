/**
 * HOR-31 — Human-facing renderers for the simulation/training mode.
 *
 * Pure, deterministic, no I/O. All output is plain text / markdown suitable
 * for a terminal.
 */

import type { InvestigationReport } from './types.js';
import type { Scenario, ScenarioEvaluation } from './simulate.js';

// ---------------------------------------------------------------------------
// Scenario list
// ---------------------------------------------------------------------------

/**
 * Render a compact list of available scenarios — one entry per scenario with
 * the symptom shown on a dimmed second line.
 */
export function renderScenarioList(scenarios: Scenario[]): string {
  const lines: string[] = [];

  lines.push('Available training scenarios');
  lines.push('');

  for (const s of scenarios) {
    lines.push(`  ${s.id}  [${s.category}]  ${s.title}`);
    lines.push(`    ${s.symptom}`);
  }

  lines.push('');
  lines.push('Run: horus simulate <id>');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Simulation report
// ---------------------------------------------------------------------------

/**
 * Render the full training simulation: the scenario context, Horus's
 * investigation findings, a signal-check scorecard, and coaching tips.
 */
export function renderSimulation(
  scenario: Scenario,
  report: InvestigationReport,
  evaluation: ScenarioEvaluation,
): string {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`# Training scenario: ${scenario.title}`);
  lines.push('');

  // ── Symptom ───────────────────────────────────────────────────────────────
  lines.push('## Symptom');
  lines.push(scenario.symptom);
  lines.push('');

  // ── Prompt for the trainee ────────────────────────────────────────────────
  lines.push(
    'Form your own hypothesis before reading on — then compare it with what Horus found.',
  );
  lines.push('');

  // ── Weak-investigation caveat ─────────────────────────────────────────────
  const isWeak = evaluation.passed < evaluation.total;
  if (isWeak) {
    lines.push(
      '> **Weak investigation** — Horus did not surface all expected signals for this scenario.',
    );
    lines.push(
      '> This can happen when the hint resolves to a symbol that is not directly connected to the expected runtime/change evidence.',
    );
    lines.push('');
  }

  // ── Horus investigation ───────────────────────────────────────────────────
  lines.push('## Horus investigation');
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  lines.push('### Top hypotheses');
  const topHypotheses = report.hypotheses.slice(0, 2);
  if (topHypotheses.length === 0) {
    lines.push('(none)');
  } else {
    for (const h of topHypotheses) {
      lines.push(`- Verdict: ${h.verdict}`);
      lines.push(`  Confidence: ${h.confidence.toFixed(2)}`);
      lines.push(`  Category: ${h.category}`);
      lines.push(`  ${h.statement}`);
    }
  }
  lines.push('');

  // ── Signal scorecard ──────────────────────────────────────────────────────
  lines.push('## Did Horus surface the expected signals?');
  lines.push('');
  for (const check of evaluation.checks) {
    const mark = check.ok ? '[x]' : '[ ]';
    lines.push(`${mark} ${check.label}`);
  }
  lines.push('');
  lines.push(`Score: ${evaluation.passed}/${evaluation.total}`);
  lines.push('');

  // ── Coaching ──────────────────────────────────────────────────────────────
  lines.push('## Coaching');
  lines.push('');
  for (const tip of scenario.coachingTips) {
    lines.push(`- ${tip}`);
  }

  // ── Specific guidance for missing queue boundary ──────────────────────────
  if (scenario.category === 'queue') {
    const queueBoundaryCheck = evaluation.checks.find(
      (c) => c.label === 'Queue boundary crossing detected',
    );
    if (queueBoundaryCheck && !queueBoundaryCheck.ok) {
      lines.push('');
      lines.push(
        '_No queue boundary was detected. The hint likely resolved to a symbol that is not directly connected to a known queue producer or worker. Try re-running with a hint that names a queue worker, producer, or the queue itself._',
      );
    }
  }

  // ── Specific guidance for missing commit evidence ─────────────────────────
  if (scenario.category === 'change') {
    const commitCheck = evaluation.checks.find(
      (c) => c.label === 'Recent change evidence found',
    );
    if (commitCheck && !commitCheck.ok) {
      lines.push('');
      lines.push(
        '_No recent change evidence was found. The deployment-regression scenario needs a diffable git range (`--since`) with commits touching the resolved symbol. Try a more specific hint or a different `--since` range._',
      );
    }
  }

  return lines.join('\n');
}
