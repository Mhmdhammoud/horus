/**
 * HOR-30 — Render helpers for WhatChangedReport.
 */

import type { WhatChangedReport } from './what-changed.js';

export function renderWhatChanged(r: WhatChangedReport): string {
  const lines: string[] = [];

  lines.push('# What changed');
  lines.push('');
  // Show the effective window so users can understand why counts may differ from horus timeline
  // (which uses all history when --since is not provided).
  const sinceLabel = r.window.since ?? '(all history)';
  const untilLabel = r.window.until ?? 'HEAD';
  lines.push('Range: ' + sinceLabel + ' → ' + untilLabel);
  lines.push(r.summary);
  lines.push('');
  lines.push('> ' + r.note);

  // Top commits
  if (r.topCommits.length > 0) {
    lines.push('');
    lines.push('## Top commits');
    for (const c of r.topCommits) {
      lines.push('  ' + c.shortSha + '  ' + c.dateIso + '  ' + c.subject);
    }
  }

  // Top contributors
  if (r.contributors.length > 0) {
    lines.push('');
    lines.push(
      '## Top contributors: ' +
        r.contributors.map((c) => c.author + ' ×' + c.commits).join(', '),
    );
  }

  // Queue topology
  lines.push('');
  if (r.queueTopology.touched) {
    lines.push(
      '## Queue topology: touched — ' + r.queueTopology.files.slice(0, 6).join(', '),
    );
  } else {
    lines.push('## Queue topology: no queue/worker files changed');
  }

  // Affected flows
  if (r.changeImpact !== null) {
    lines.push('');
    lines.push(
      '## Affected flows: ' + r.changeImpact.affectedFlows.length + ' execution flow(s) affected',
    );
    if (r.changeImpact.affectedFlows.length > 0) {
      for (const f of r.changeImpact.affectedFlows) {
        lines.push('  - ' + f.flowName);
      }
    }
  }

  return lines.join('\n');
}

export function whatChangedToJSON(r: WhatChangedReport): string {
  return JSON.stringify(r, null, 2);
}
