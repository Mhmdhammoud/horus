import type { ArchitectureModel } from './architecture.js';

export function renderArchitecture(m: ArchitectureModel): string {
  const lines: string[] = [];

  lines.push('# Architecture (discovered)');
  lines.push('');

  // Summary
  lines.push(m.summary);
  lines.push('');

  // Subsystems
  lines.push('## Subsystems (most central first)');
  if (m.subsystems.length === 0) {
    lines.push('(none)');
  } else {
    for (const s of m.subsystems) {
      lines.push(`- ${s.name} — ${s.members} members`);
    }
  }
  lines.push('');

  // Async boundaries
  lines.push('## Async boundaries');
  if (m.asyncBoundaries.length === 0) {
    lines.push('(none)');
  } else {
    for (const b of m.asyncBoundaries) {
      const producers = b.producers.length > 0 ? b.producers.join(', ') : '(unknown)';
      const workers = b.workers.length > 0 ? b.workers.join(', ') : '(unknown)';
      lines.push(`- ${b.queueName}: ${producers} -> ${workers}`);
    }
  }
  lines.push('');

  // External systems
  lines.push('## External systems');
  if (m.externalSystems.length === 0) {
    lines.push('(none)');
  } else {
    for (const e of m.externalSystems) {
      lines.push(`- ${e.name} (${e.files} files)`);
    }
  }
  lines.push('');

  // Key flows
  lines.push('## Key flows');
  if (m.keyFlows.length === 0) {
    lines.push('(none)');
  } else {
    for (const f of m.keyFlows) {
      lines.push(`- ${f}`);
    }
  }
  lines.push('');

  // Graph node stats
  lines.push('## Graph');
  if (m.nodeStats.length === 0) {
    lines.push('(no data)');
  } else {
    for (const s of m.nodeStats) {
      lines.push(`${s.label} × ${s.count}`);
    }
  }
  lines.push('');

  // Fragility
  lines.push('## Fragility');
  lines.push(`- Unreferenced symbols: ${m.fragile.deadCode}`);
  lines.push(`- High-coupling pairs (co-changes ≥ 3): ${m.fragile.highCouplingPairs}`);

  return lines.join('\n');
}

export function architectureToJSON(m: ArchitectureModel): string {
  return JSON.stringify(m, null, 2);
}
