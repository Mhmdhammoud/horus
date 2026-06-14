/**
 * HOR-30 — 'what changed' entry point.
 * Composes HOR-22 reconstruction and adds ownership + queue-topology signals.
 * Produces a concise, evidence-backed change summary for a service + window.
 */

import type { CodeProvider, GitCommit } from '@horus/connectors';
import { reconstructChangeTimeline } from './deploy-timeline.js';
import type { ChangeImpactReport } from './changes.js';

export interface Contributor {
  author: string;
  commits: number;
}

export interface WhatChangedReport {
  window: {
    since: string | null;
    until: string | null;
    service: string | null;
  };
  commitCount: number;
  topCommits: GitCommit[];
  changeImpact: ChangeImpactReport | null;
  contributors: Contributor[];
  queueTopology: {
    touched: boolean;
    files: string[];
  };
  summary: string;
  note: string;
}

export async function whatChanged(
  input: {
    repoPath: string;
    since?: string;
    until?: string;
    service?: string;
  },
  deps: { code: CodeProvider },
): Promise<WhatChangedReport> {
  const t = await reconstructChangeTimeline(input, deps);

  // Tally commits by author
  const authorMap = new Map<string, number>();
  for (const commit of t.commits) {
    const prev = authorMap.get(commit.author) ?? 0;
    authorMap.set(commit.author, prev + 1);
  }
  const contributors: Contributor[] = [...authorMap]
    .map(([author, commits]) => ({ author, commits }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 5);

  // Queue topology: collect files matching queue/processor patterns
  const queueFileSet = new Set<string>();
  for (const commit of t.commits) {
    for (const file of commit.files) {
      const lower = file.toLowerCase();
      if (
        /\.(processor|module)\.ts$/i.test(file) ||
        lower.includes('queue') ||
        lower.includes('processor')
      ) {
        queueFileSet.add(file);
        if (queueFileSet.size >= 20) break;
      }
    }
    if (queueFileSet.size >= 20) break;
  }
  const queueFiles = [...queueFileSet].slice(0, 20);
  const queueTopology = {
    touched: queueFiles.length > 0,
    files: queueFiles,
  };

  const topCommits = t.commits.slice(0, 3);

  const topContributor = contributors[0];
  const summary =
    t.commits.length +
    ' commit(s)' +
    (input.service !== undefined ? ' touching ' + input.service : '') +
    (input.since !== undefined ? ' since ' + input.since : '') +
    (t.changeImpact !== null
      ? '; ' +
        t.changeImpact.added.length +
        ' symbols added/' +
        t.changeImpact.modified.length +
        ' modified/' +
        t.changeImpact.removed.length +
        ' removed'
      : '') +
    (topContributor !== undefined
      ? '; top contributor ' + topContributor.author + ' (' + topContributor.commits + ')'
      : '') +
    (queueTopology.touched ? '; queue/worker files changed (topology may have shifted)' : '') +
    '.';

  const note =
    'A change is evidence, not a conclusion — confirm with logs/metrics before blaming a change.';

  return {
    window: {
      since: input.since ?? null,
      until: input.until ?? null,
      service: input.service ?? null,
    },
    commitCount: t.commits.length,
    topCommits,
    changeImpact: t.changeImpact,
    contributors,
    queueTopology,
    summary,
    note,
  };
}
