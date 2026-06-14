import type { BlastRadiusReport } from './blast-radius.js';

export function renderBlastRadius(r: BlastRadiusReport): string {
  const lines: string[] = [];

  lines.push('# Blast radius: ' + r.seed.name);
  lines.push('');
  lines.push(r.summary);
  lines.push('');
  lines.push('> ' + r.note);
  lines.push('');

  // Upstream section
  lines.push('## Upstream (where failure could originate — what the seed depends on)');
  if (r.upstream.length === 0 && r.asyncUpstream.length === 0) {
    lines.push('  (none)');
  } else {
    const upstreamSlice = r.upstream.slice(0, 15);
    for (const sym of upstreamSlice) {
      lines.push('  ' + sym.name + ' (' + (sym.filePath ?? 'unknown') + ')');
    }
    for (const dep of r.asyncUpstream) {
      lines.push(
        '  async: ' +
          dep.counterpart +
          ' (' +
          (dep.counterpartFile ?? 'unknown') +
          ') [via queue: ' +
          dep.queueName +
          ']',
      );
    }
  }
  lines.push('');

  // Downstream section
  lines.push('## Downstream (affected if the seed fails)');
  if (r.downstream.length === 0 && r.asyncDownstream.length === 0) {
    lines.push('  (none)');
  } else {
    for (const layer of r.downstream) {
      const syms = layer.symbols.slice(0, 12);
      const names = syms.map((s) => s.name);
      const extra = layer.symbols.length > 12 ? ' +' + (layer.symbols.length - 12) + ' more' : '';
      lines.push('  depth ' + layer.depth + ': ' + names.join(', ') + extra);
    }
    for (const dep of r.asyncDownstream) {
      lines.push(
        '  async worker: ' +
          dep.counterpart +
          ' (' +
          (dep.counterpartFile ?? 'unknown') +
          ') [via queue: ' +
          dep.queueName +
          ']',
      );
    }
  }
  lines.push('');

  // Async boundaries section
  lines.push('## Async boundaries');
  if (r.asyncUpstream.length === 0 && r.asyncDownstream.length === 0) {
    lines.push('  (none)');
  } else {
    for (const dep of r.asyncUpstream) {
      lines.push(
        '  ' +
          dep.queueName +
          ': upstream producer -> ' +
          dep.counterpart +
          (dep.counterpartFile ? ' (' + dep.counterpartFile + ')' : ''),
      );
    }
    for (const dep of r.asyncDownstream) {
      lines.push(
        '  ' +
          dep.queueName +
          ': downstream worker -> ' +
          dep.counterpart +
          (dep.counterpartFile ? ' (' + dep.counterpartFile + ')' : ''),
      );
    }
  }
  lines.push('');

  // Blast radius summary
  lines.push('## Blast radius');
  lines.push('  ' + r.blastRadius + ' symbol(s) affected — criticality: ' + r.criticality);

  return lines.join('\n');
}

export function blastRadiusToJSON(r: BlastRadiusReport): string {
  return JSON.stringify(r, null, 2);
}
