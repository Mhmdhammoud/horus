/**
 * Human-facing renderers for a ChangeImpactReport. Pure, deterministic, no I/O.
 */

import type { Symbol } from '@horus/core';
import type { ChangeImpactReport } from './changes.js';

const LIST_CAP = 15;

function symbolLine(s: Symbol): string {
  return `${s.name} (${s.filePath})`;
}

function renderSymbolList(label: string, symbols: Symbol[]): string[] {
  if (symbols.length === 0) return [];
  const lines: string[] = [`### ${label}`];
  const shown = symbols.slice(0, LIST_CAP);
  for (const s of shown) {
    lines.push(`- ${symbolLine(s)}`);
  }
  const remaining = symbols.length - shown.length;
  if (remaining > 0) {
    lines.push(`  +${remaining} more`);
  }
  return lines;
}

/** Sectioned text report for terminal output. */
export function renderChangeImpact(r: ChangeImpactReport): string {
  const lines: string[] = [];

  lines.push(`# Change Impact: ${r.base}..${r.compare}`);
  lines.push('');

  lines.push('## Summary');
  lines.push(r.summary);
  lines.push('');

  const addedLines = renderSymbolList('Added', r.added);
  if (addedLines.length > 0) {
    lines.push(...addedLines);
    lines.push('');
  }

  const modifiedAfters = r.modified.map((m) => m.after);
  const modifiedLines = renderSymbolList('Modified', modifiedAfters);
  if (modifiedLines.length > 0) {
    lines.push(...modifiedLines);
    lines.push('');
  }

  const removedLines = renderSymbolList('Removed', r.removed);
  if (removedLines.length > 0) {
    lines.push(...removedLines);
    lines.push('');
  }

  lines.push('## Affected flows');
  if (r.affectedFlows.length === 0) {
    lines.push('none');
  } else {
    for (const f of r.affectedFlows) {
      lines.push(`- ${f.flowName} — changed: ${f.changedSymbols.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/** Stable JSON serialization of the full report. */
export function changeImpactToJSON(r: ChangeImpactReport): string {
  return JSON.stringify(r, null, 2);
}
