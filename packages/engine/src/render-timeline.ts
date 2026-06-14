/**
 * Human-facing renderers for a ChangeTimeline. Pure, deterministic, no I/O.
 */

import type { ChangeTimeline } from './deploy-timeline.js';

const COMMIT_CAP = 25;

/** Sectioned text report for terminal output. */
export function renderChangeTimeline(t: ChangeTimeline): string {
  const lines: string[] = [];

  lines.push('# Change Timeline');
  lines.push('');

  lines.push('## Summary');
  lines.push(t.summary);
  lines.push('');

  lines.push('> ' + t.note);
  lines.push('');

  lines.push('## Commits');
  if (t.commits.length === 0) {
    lines.push('  (none in window)');
  } else {
    const shown = t.commits.slice(0, COMMIT_CAP);
    for (const c of shown) {
      lines.push(
        '  ' +
          c.shortSha +
          ' ' +
          c.dateIso +
          '  ' +
          c.subject +
          '  (' +
          c.files.length +
          ' file(s))',
      );
    }
    const remaining = t.commits.length - shown.length;
    if (remaining > 0) {
      lines.push('  +' + remaining + ' more');
    }
  }

  if (t.changeImpact !== null) {
    lines.push('');
    lines.push('## Change impact');
    lines.push(
      t.changeImpact.summary +
        ' Affected flows: ' +
        t.changeImpact.affectedFlows.length +
        '.',
    );
  }

  return lines.join('\n');
}

/** Stable JSON serialization of the full timeline. */
export function changeTimelineToJSON(t: ChangeTimeline): string {
  return JSON.stringify(t, null, 2);
}
