/**
 * HOR-22 — Deployment / change-timeline reconstruction.
 * Treats git history as EVIDENCE, not conclusions.
 */

import type { GitCommit } from '@horus/connectors';
import type { CodeProvider } from '@horus/connectors';
import { changeImpact, type ChangeImpactReport } from './changes.js';
import { gitLog } from '@horus/connectors';

export interface ChangeTimelineInput {
  repoPath: string;
  since?: string;
  until?: string;
  service?: string;
}

export interface ChangeTimeline {
  window: { since: string | null; until: string | null; service: string | null };
  commits: GitCommit[];
  changeImpact: ChangeImpactReport | null;
  summary: string;
  note: string;
}

export async function reconstructChangeTimeline(
  input: ChangeTimelineInput,
  deps: { code: CodeProvider },
): Promise<ChangeTimeline> {
  let commits = await gitLog(input.repoPath, {
    since: input.since,
    until: input.until,
  });

  const service = input.service;

  if (service !== undefined) {
    commits = commits.filter((c) =>
      c.files.some((f) => f.toLowerCase().includes(service.toLowerCase())),
    );
  }

  let impact: ChangeImpactReport | null = null;

  if (commits.length >= 1) {
    const oldest = commits[commits.length - 1];
    const newest = commits[0];
    if (oldest !== undefined && newest !== undefined) {
      const base = oldest.sha + '^';
      const compare = newest.sha;
      try {
        impact = await changeImpact({ base, compare }, deps);
      } catch {
        impact = null;
      }
    }
  }

  const summary =
    commits.length +
    ' commit(s)' +
    (service !== undefined ? ' touching ' + service : '') +
    ' in window' +
    (input.since !== undefined ? ' since ' + input.since : '') +
    (impact !== null ? '; ' + impact.summary : '') +
    '.';

  const note =
    'Changes are evidence, not conclusions — a change in this window is not automatically the cause.';

  return {
    window: {
      since: input.since ?? null,
      until: input.until ?? null,
      service: service ?? null,
    },
    commits,
    changeImpact: impact,
    summary,
    note,
  };
}
