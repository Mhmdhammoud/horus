/**
 * HOR-27 — Rendering for QualityScore.
 */

import type { QualityScore } from './score.js';

export function renderScore(s: QualityScore): string {
  const lines: string[] = [];
  lines.push('# Investigation quality: ' + s.score + '/100 (' + s.grade + ')');
  for (const c of s.components) {
    lines.push(
      '  ' +
        c.dimension +
        ': ' +
        (c.value * 100).toFixed(0) +
        '% (weight ' +
        c.weight +
        ') — ' +
        c.note,
    );
  }
  lines.push(s.summary);
  return lines.join('\n');
}

export function scoreToJSON(s: QualityScore): string {
  return JSON.stringify(s, null, 2);
}
