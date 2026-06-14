/**
 * Human-facing renderers for an InvestigationReport. Pure, deterministic, no I/O.
 */

import type { InvestigationReport } from './types.js';

/** Short, citable evidence id (first 8 chars). */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A clean, sectioned text report suitable for a terminal or a log. */
export function renderReport(r: InvestigationReport): string {
  const lines: string[] = [];

  lines.push(`# Investigation ${r.id}`);
  lines.push(`Hint: ${r.input.hint}`);
  if (r.input.repo) lines.push(`Repo: ${r.input.repo}`);
  if (r.input.service) lines.push(`Service: ${r.input.service}`);
  if (r.input.since) lines.push(`Since: ${r.input.since}`);
  lines.push(`Confidence: ${r.confidence.toFixed(2)}`);
  lines.push('');

  lines.push('## Summary');
  lines.push(r.summary);
  lines.push('');

  lines.push('## Seed(s)');
  if (r.seeds.length === 0) {
    lines.push('(none)');
  } else {
    for (const s of r.seeds) {
      const line = s.startLine ?? 0;
      const sig = s.signature ? ` — ${s.signature}` : '';
      lines.push(`- ${s.name} (${s.filePath}:${line})${sig}`);
    }
  }
  lines.push('');

  lines.push('## Findings');
  if (r.findings.length === 0) {
    lines.push('(none)');
  } else {
    for (const f of r.findings) {
      lines.push(`- [${f.confidence.toFixed(2)}] ${f.title}`);
      if (f.detail) lines.push(`    ${f.detail}`);
      if (f.evidenceIds.length > 0) {
        lines.push(`    evidence: ${f.evidenceIds.map(shortId).join(', ')}`);
      }
    }
  }
  lines.push('');

  lines.push('## Timeline');
  if (r.timeline.events.length === 0) {
    lines.push('(none)');
  } else {
    for (const ev of r.timeline.events) {
      const at = ev.at ?? 'structural';
      lines.push(`  ${ev.order}. [${at}] ${ev.title}`);
    }
  }
  lines.push('');

  lines.push('## Boundary crossings');
  if (r.timeline.boundaryCrossings.length === 0) {
    lines.push('(none)');
  } else {
    for (const bc of r.timeline.boundaryCrossings) {
      const producer = bc.producer ?? '?';
      const worker = bc.worker ?? '?';
      lines.push(`  ${bc.queueName}: ${producer} -> ${worker}`);
    }
  }
  lines.push('');

  lines.push('## Correlation');

  lines.push('### Cause chains');
  if (r.correlation.chains.length === 0) {
    lines.push('  (none)');
  } else {
    for (const chain of r.correlation.chains) {
      lines.push(`  [${chain.strength.toFixed(2)}] ${chain.title} — ${chain.rationale}`);
    }
  }

  lines.push('### Related evidence groups');
  if (r.correlation.groups.length === 0) {
    lines.push('  (none)');
  } else {
    for (const group of r.correlation.groups) {
      lines.push(`  ${group.reason} (${group.evidenceIds.length} items)`);
    }
  }

  lines.push('### Missing evidence');
  if (r.correlation.missing.length === 0) {
    lines.push('  none');
  } else {
    for (const m of r.correlation.missing) {
      lines.push(`  - ${m.note}`);
    }
  }
  lines.push('');

  lines.push('## Suspected causes (ranked)');
  if (r.suspectedCauses.length === 0) {
    lines.push('(none)');
  } else {
    r.suspectedCauses.forEach((c, i) => {
      lines.push(`${i + 1}. [${c.score.toFixed(2)}] ${c.statement}`);
      if (c.evidenceIds.length > 0) {
        lines.push(`    evidence: ${c.evidenceIds.map(shortId).join(', ')}`);
      }
    });
  }
  lines.push('');

  lines.push('## Evidence');
  if (r.evidence.length === 0) {
    lines.push('(none)');
  } else {
    for (const e of r.evidence) {
      lines.push(`- ${shortId(e.id)} [${e.source}/${e.kind}] ${e.title}`);
    }
  }
  lines.push('');

  lines.push('## Next actions');
  if (r.nextActions.length === 0) {
    lines.push('(none)');
  } else {
    for (const a of r.nextActions) {
      lines.push(`- ${a}`);
    }
  }

  return lines.join('\n');
}

/** Stable JSON serialization of the full report. */
export function reportToJSON(r: InvestigationReport): string {
  return JSON.stringify(r, null, 2);
}
