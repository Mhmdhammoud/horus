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
  // Show the effective window so users understand why counts may differ from horus what-changed
  // (which defaults to 7 days) or horus changes (which takes explicit refs).
  const sinceLabel = t.window.since ?? '(all history)';
  const untilLabel = t.window.until ?? 'HEAD';
  lines.push('Range: ' + sinceLabel + ' → ' + untilLabel);
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
    // Show the exact git refs so users can cross-reference with horus changes <base> <compare>.
    lines.push('Git range: ' + t.changeImpact.base + '..' + t.changeImpact.compare);
    lines.push(t.changeImpact.summary);
    if (t.changeImpact.affectedFlows.length > 0) {
      for (const f of t.changeImpact.affectedFlows) {
        lines.push('  - ' + f.flowName);
      }
    }
  }

  return lines.join('\n');
}

/** Stable JSON serialization of the full timeline. */
export function changeTimelineToJSON(t: ChangeTimeline): string {
  return JSON.stringify(t, null, 2);
}
