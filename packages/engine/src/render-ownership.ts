/**
 * Render helpers for OwnershipEstimate (HOR-20).
 */

import type { OwnershipEstimate } from './ownership.js';

export function renderOwnership(o: OwnershipEstimate): string {
  const lines: string[] = [];

  lines.push('# Ownership: ' + o.query);
  lines.push('');

  if (o.file === null) {
    lines.push(o.note);
    return lines.join('\n');
  }

  if (o.symbol !== null) {
    lines.push('Symbol : ' + o.symbol.name);
  }
  lines.push('File   : ' + o.file);
  lines.push('');

  const pct = (o.confidence * 100).toFixed(0);
  lines.push(
    'Likely maintainer  : ' +
      (o.likelyMaintainer ?? '(unknown)') +
      ' (' +
      pct +
      '% confidence)',
  );
  lines.push('Most active recently: ' + (o.mostActiveRecent ?? '(unknown)'));
  lines.push('');

  lines.push('Contributors:');
  const capped = o.contributors.slice(0, 8);
  for (const c of capped) {
    lines.push(
      '  ' + c.author + ' × ' + c.commits + ' commits,  last ' + c.lastDate,
    );
  }
  if (o.contributors.length > 8) {
    lines.push('  … and ' + (o.contributors.length - 8) + ' more');
  }
  lines.push('');

  if (o.evidence.length > 0) {
    lines.push('Evidence:');
    for (const e of o.evidence) {
      lines.push('  • ' + e);
    }
    lines.push('');
  }

  lines.push('Note: ' + o.note);

  return lines.join('\n');
}

export function ownershipToJSON(o: OwnershipEstimate): string {
  return JSON.stringify(o, null, 2);
}
