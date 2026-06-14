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

  lines.push('## Similar past incidents');
  if (r.similarIncidents.length === 0) {
    lines.push('(none on record)');
  } else {
    for (const s of r.similarIncidents) {
      lines.push(
        `- ${s.title} (overlap ${(s.overlap * 100).toFixed(0)}%) — shared: ${s.sharedTags.join(', ')}`,
      );
      if (s.summary) {
        const truncated =
          s.summary.length > 80 ? s.summary.slice(0, 77) + '...' : s.summary;
        lines.push(`    ${truncated}`);
      }
    }
    lines.push(
      'Context only — past incidents inform, but never override, the current evidence.',
    );
  }
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

  lines.push('## Hypotheses');
  if (r.hypotheses.length === 0) {
    lines.push('(none)');
  } else {
    for (const h of r.hypotheses) {
      lines.push(
        `  [${h.verdict}] [${h.confidence.toFixed(2)} (was ${h.priorConfidence.toFixed(2)})] ${h.category}: ${h.statement}`,
      );
      lines.push(`      ${h.rationale}`);
      if (h.missingEvidence.length > 0) {
        lines.push(`      · missing: ${h.missingEvidence.join('; ')}`);
      }
    }
  }
  lines.push('');

  lines.push('## Evidence gaps (what we don\'t know)');
  if (r.gapAnalysis.gaps.length === 0) {
    lines.push('(no major evidence gaps)');
  } else {
    for (const gap of r.gapAnalysis.gaps) {
      lines.push(
        `  - ${gap.dimension}: ${gap.why}  → next: ${gap.nextSource}  (−${gap.confidenceImpact.toFixed(2)} conf)`,
      );
    }
    lines.push('');
    lines.push('Blind spots:');
    for (const bs of r.gapAnalysis.blindSpots) {
      lines.push(`  - ${bs}`);
    }
    lines.push('');
    lines.push(
      `Confidence ceiling: ${r.gapAnalysis.confidenceCeiling} (current confidence is capped at this until the gaps are filled).`,
    );
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

/**
 * A concise, shareable Markdown report — the deterministic output contract for
 * `horus investigate` (HOR-9). Suitable for pasting into a Linear ticket, Slack,
 * or a postmortem. Distinct from `renderReport` (the verbose terminal/log dump):
 * this is the at-a-glance brief with the six required sections.
 */
export function reportToMarkdown(r: InvestigationReport): string {
  const out: string[] = [];

  out.push(`# Investigation Report — ${r.input.hint}`);
  out.push('');
  out.push(`**Confidence:** ${r.confidence.toFixed(2)}`);
  if (r.input.service) out.push(`**Service:** ${r.input.service}`);
  if (r.input.since) out.push(`**Since:** ${r.input.since}`);
  out.push('');
  out.push('## Summary');
  out.push(r.summary);
  out.push('');

  out.push('## Similar past incidents');
  if (r.similarIncidents.length === 0) {
    out.push('(none on record)');
  } else {
    for (const s of r.similarIncidents) {
      out.push(
        `- ${s.title} (overlap ${(s.overlap * 100).toFixed(0)}%) — shared: ${s.sharedTags.join(', ')}`,
      );
      if (s.summary) {
        const truncated =
          s.summary.length > 80 ? s.summary.slice(0, 77) + '...' : s.summary;
        out.push(`  _${truncated}_`);
      }
    }
    out.push(
      '_Context only — past incidents inform, but never override, the current evidence._',
    );
  }
  out.push('');

  out.push('## Suspected causes');
  if (r.suspectedCauses.length === 0) {
    out.push('_none_');
  } else {
    r.suspectedCauses.forEach((c, i) => {
      out.push(`${i + 1}. **(${c.score.toFixed(2)})** ${c.statement}`);
    });
  }
  out.push('');

  out.push('## Hypotheses');
  if (r.hypotheses.length === 0) {
    out.push('_none_');
  } else {
    for (const h of r.hypotheses) {
      out.push(
        `- \`${h.verdict}\` **${h.confidence.toFixed(2)}** (was ${h.priorConfidence.toFixed(2)}) — ${h.category}: ${h.statement}`,
      );
    }
  }
  out.push('');

  out.push('## Evidence gaps (what we don\'t know)');
  if (r.gapAnalysis.gaps.length === 0) {
    out.push('_(no major evidence gaps)_');
  } else {
    for (const gap of r.gapAnalysis.gaps) {
      out.push(
        `- **${gap.dimension}**: ${gap.why}  → _next: ${gap.nextSource}_ (−${gap.confidenceImpact.toFixed(2)} conf)`,
      );
    }
    out.push('');
    out.push('**Blind spots:**');
    for (const bs of r.gapAnalysis.blindSpots) {
      out.push(`- ${bs}`);
    }
    out.push('');
    out.push(
      `_Confidence ceiling: **${r.gapAnalysis.confidenceCeiling}** — current confidence is capped at this until the gaps are filled._`,
    );
  }
  out.push('');

  out.push('## Timeline');
  if (r.timeline.events.length === 0) {
    out.push('_none_');
  } else {
    for (const ev of r.timeline.events) {
      out.push(`${ev.order}. \`${ev.at ?? 'structural'}\` ${ev.title}`);
    }
  }
  out.push('');

  out.push(`## Evidence (${r.evidence.length})`);
  if (r.evidence.length === 0) {
    out.push('_none_');
  } else {
    for (const e of r.evidence) {
      out.push(`- \`${shortId(e.id)}\` [${e.source}/${e.kind}] ${e.title}`);
    }
  }
  out.push('');

  out.push('## Next actions');
  if (r.nextActions.length === 0) {
    out.push('_none_');
  } else {
    for (const a of r.nextActions) {
      out.push(`- [ ] ${a}`);
    }
  }
  out.push('');
  out.push('---');
  out.push('_Generated by Horus — deterministic report, no AI._');

  return out.join('\n');
}
