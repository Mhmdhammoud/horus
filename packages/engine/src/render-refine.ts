/**
 * HOR-21 — Renderers for a RefinedView of an InvestigationReport.
 * Pure, deterministic, no I/O.
 */

import type { InvestigationReport } from './types.js';
import type { RefinedView } from './refine.js';

/** Short, citable evidence id (first 8 chars). */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Render a refined investigation view as a terminal-friendly text block.
 * Reuses saved evidence — no re-query of production.
 */
export function renderRefined(r: InvestigationReport, v: RefinedView): string {
  const lines: string[] = [];

  lines.push('# Refined investigation — ' + r.input.hint);
  lines.push('');

  const modeLabel =
    v.mode === 'focus'
      ? 'focus: ' + v.topics.join(', ')
      : v.mode === 'ignore'
        ? 'ignore: ' + v.topics.join(', ')
        : v.mode === 'mixed'
          ? 'focus+ignore' + (v.topics.length > 0 ? ': ' + v.topics.join(', ') : '')
          : 'none (all evidence returned)';
  lines.push('  [mode: ' + modeLabel + '] reusing saved evidence, no re-query');
  lines.push('');

  lines.push('## Hypotheses');
  if (v.hypotheses.length === 0) {
    lines.push('_(nothing matches this directive)_');
  } else {
    for (const h of v.hypotheses) {
      lines.push(
        '  [' +
          h.verdict +
          '] [' +
          h.confidence.toFixed(2) +
          '] ' +
          h.category +
          ': ' +
          h.statement,
      );
    }
  }
  lines.push('');

  lines.push('## Suspected causes');
  if (v.suspectedCauses.length === 0) {
    lines.push('_(nothing matches this directive)_');
  } else {
    v.suspectedCauses.forEach((c, i) => {
      lines.push(i + 1 + '. [' + c.finalScore.toFixed(2) + ' / ' + c.band + '] ' + c.title);
    });
  }
  lines.push('');

  lines.push('## Evidence');
  if (v.evidence.length === 0) {
    lines.push('_(nothing matches this directive)_');
  } else {
    for (const e of v.evidence) {
      lines.push('- ' + shortId(e.id) + ' [' + e.source + '/' + e.kind + '] ' + e.title);
    }
  }
  lines.push('');

  lines.push('> ' + v.note);

  return lines.join('\n');
}

/** Stable JSON serialization of the refined view alongside its source report id. */
export function refinedToJSON(r: InvestigationReport, v: RefinedView): string {
  return JSON.stringify(
    {
      investigationId: r.id,
      hint: r.input.hint,
      directive: v.directive,
      mode: v.mode,
      topics: v.topics,
      hypotheses: v.hypotheses,
      suspectedCauses: v.suspectedCauses,
      evidence: v.evidence,
      note: v.note,
    },
    null,
    2,
  );
}
