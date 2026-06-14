/**
 * Ownership estimation from git commit history (HOR-20).
 * Output is probabilistic — always carries confidence + evidence.
 * Confidence is capped at 0.95; this is NEVER an org-chart lookup.
 */

import type { CodeProvider, FileContributor } from '@horus/connectors';
import { gitFileContributors } from '@horus/connectors';
import type { Symbol } from '@horus/core';

export interface OwnershipEstimate {
  query: string;
  symbol: Symbol | null;
  file: string | null;
  contributors: FileContributor[];
  likelyMaintainer: string | null;
  maintainerShare: number;
  mostActiveRecent: string | null;
  confidence: number;
  evidence: string[];
  note: string;
}

/**
 * Estimate who likely owns a component by searching for the closest symbol and
 * examining its file's git commit history.
 *
 * Pass `deps.symbol` to reuse an already-resolved seed and skip the Axon search.
 */
export async function estimateOwnership(
  query: string,
  deps: { code: CodeProvider; repoPath: string; symbol?: Symbol | null },
): Promise<OwnershipEstimate> {
  // Reuse the caller's resolved symbol when provided — avoids a duplicate Axon
  // search and prevents a different duplicate-name match from diverging ownership.
  const top: Symbol | null = deps.symbol ?? (await deps.code.searchSymbols(query, 5))[0] ?? null;
  const file = top?.filePath ?? null;

  if (file === null) {
    return {
      query,
      symbol: null,
      file: null,
      contributors: [],
      likelyMaintainer: null,
      maintainerShare: 0,
      mostActiveRecent: null,
      confidence: 0,
      evidence: [],
      note: 'No source symbol matched the query — cannot estimate ownership.',
    };
  }

  const contributors = await gitFileContributors(deps.repoPath, file);

  const total = contributors.reduce((n, c) => n + c.commits, 0);
  const lead = contributors[0] ?? null;
  const maintainerShare = total > 0 && lead !== null ? lead.commits / total : 0;

  // Most active recently = contributor with the latest lastDate
  const byRecent = [...contributors].sort((a, b) =>
    b.lastDate < a.lastDate ? -1 : b.lastDate > a.lastDate ? 1 : 0,
  );
  const mostActiveRecent = byRecent[0]?.author ?? null;

  const confidence = Math.min(0.95, maintainerShare);

  const evidence: string[] = [];
  if (lead !== null) {
    evidence.push(lead.commits + ' of ' + total + ' commits to ' + file);
    evidence.push('last touched ' + lead.lastDate + ' by ' + lead.author);
    evidence.push(contributors.length + ' distinct contributor(s)');
  }

  return {
    query,
    symbol: top,
    file,
    contributors,
    likelyMaintainer: lead?.author ?? null,
    maintainerShare,
    mostActiveRecent,
    confidence,
    evidence,
    note: 'Estimate from git commit history only — not an org chart or HR data; confirm with the team.',
  };
}
