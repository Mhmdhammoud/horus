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
  /** Populated when multiple files match a file-path query and the result is ambiguous. */
  candidates?: string[];
  note: string;
}

// Extensions treated as file-path queries (not symbol names).
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'cs', 'cpp', 'c', 'h', 'hpp', 'cc',
  'vue', 'svelte', 'astro',
  'php', 'scala', 'clj', 'ex', 'exs', 'hs',
  'sh', 'bash', 'zsh',
  'json', 'yaml', 'yml', 'toml',
  'sql', 'graphql', 'proto',
  'html', 'css', 'scss', 'sass', 'less',
  'md', 'mdx',
]);

function looksLikeFilePath(query: string): boolean {
  const base = query.split('/').pop() ?? '';
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return false;
  return CODE_EXTENSIONS.has(base.slice(dotIdx + 1).toLowerCase());
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
  let top: Symbol | null = deps.symbol ?? null;
  const needsSearch = deps.symbol === undefined || deps.symbol === null;

  if (needsSearch) {
    if (looksLikeFilePath(query)) {
      // File-path query: search broadly then prefer exact basename / path-suffix matches
      // over whatever fuzzy symbol the provider returns as top-1.
      const queryBase = query.split('/').pop() ?? query;
      const broad = await deps.code.searchSymbols(query, 20);

      const byFile = new Map<string, Symbol>();
      for (const sym of broad) {
        const fp = sym.filePath;
        if (fp === query || fp.endsWith('/' + query) || fp.split('/').pop() === queryBase) {
          if (!byFile.has(fp)) byFile.set(fp, sym);
        }
      }

      if (byFile.size === 1) {
        top = [...byFile.values()][0] ?? null;
      } else if (byFile.size > 1) {
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
          candidates: [...byFile.keys()],
          note:
            'Ambiguous: ' +
            byFile.size +
            ' files match "' +
            query +
            '". Use a more specific path to disambiguate.',
        };
      } else {
        // No exact file match — fall back to fuzzy symbol search.
        top = (await deps.code.searchSymbols(query, 5))[0] ?? null;
      }
    } else {
      // Symbol/class/function query — fuzzy search as before.
      top = (await deps.code.searchSymbols(query, 5))[0] ?? null;
    }
  }

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
