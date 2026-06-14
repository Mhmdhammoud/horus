import type { OnboardingGuide } from './onboard.js';

export function renderOnboarding(g: OnboardingGuide): string {
  const lines: string[] = [];

  // Title
  lines.push(g.area != null ? '# Onboarding: ' + g.area : '# Onboarding');
  lines.push('');
  lines.push(g.summary);
  lines.push('');

  // How this system works
  lines.push('## How this system works');
  lines.push('');
  const subsystems = g.architecture.subsystems.slice(0, 8);
  if (subsystems.length === 0) {
    lines.push('No subsystem data available.');
  } else {
    for (const s of subsystems) {
      lines.push(`- **${s.name}** — ${s.members} members`);
    }
  }
  lines.push('');
  if (g.architecture.externalSystems.length > 0) {
    lines.push('External systems:');
    for (const e of g.architecture.externalSystems) {
      lines.push(`- ${e.name} (${e.files} files)`);
    }
  } else {
    lines.push('No external systems detected.');
  }
  lines.push('');

  // Critical paths
  lines.push('## Critical paths');
  lines.push('');
  const keyFlows = g.architecture.keyFlows.slice(0, 10);
  if (keyFlows.length === 0) {
    lines.push('No key flows detected.');
  } else {
    for (const f of keyFlows) {
      lines.push(`- ${f}`);
    }
  }
  lines.push('');
  if (g.architecture.asyncBoundaries.length > 0) {
    lines.push('Async boundaries:');
    for (const b of g.architecture.asyncBoundaries) {
      const producers = b.producers.length > 0 ? b.producers.join(', ') : '(unknown)';
      const workers = b.workers.length > 0 ? b.workers.join(', ') : '(unknown)';
      lines.push(`- ${b.queueName}: ${producers} -> ${workers}`);
    }
  } else {
    lines.push('No async boundaries detected.');
  }
  lines.push('');

  // What usually breaks
  lines.push('## What usually breaks');
  lines.push('');
  lines.push(`- Dead-code symbols: ${g.architecture.fragile.deadCode}`);
  lines.push(
    `- High-coupling pairs (co-changes ≥ 3): ${g.architecture.fragile.highCouplingPairs}`,
  );
  lines.push('');
  if (g.architecture.asyncBoundaries.length > 0) {
    lines.push('Async boundaries are the usual failure points:');
    for (const b of g.architecture.asyncBoundaries) {
      lines.push(`- ${b.queueName}`);
    }
  }
  lines.push('');

  // Who owns this area
  lines.push('## Who owns this area');
  lines.push('');
  if (g.ownership != null && g.ownership.file != null) {
    const pct = (g.ownership.confidence * 100).toFixed(0);
    lines.push(`File: ${g.ownership.file}`);
    lines.push(
      `Likely maintainer: ${g.ownership.likelyMaintainer ?? '(unknown)'} (${pct}% confidence)`,
    );
  } else {
    lines.push(
      '_Pass an area (e.g. horus onboard zoho) or run: horus owner <symbol>_',
    );
  }
  lines.push('');

  // Past incidents
  lines.push('## Past incidents');
  lines.push('');
  if (g.pastIncidents.length === 0) {
    lines.push('_none on record_');
  } else {
    for (const inc of g.pastIncidents) {
      const ts = inc.createdAt ?? '(no date)';
      lines.push(`- ${ts} ${inc.title}`);
    }
  }
  lines.push('');

  lines.push(
    '_Generated from live code structure + git + investigation history — deterministic, no AI._',
  );

  return lines.join('\n');
}

export function onboardingToJSON(g: OnboardingGuide): string {
  return JSON.stringify(g, null, 2);
}
