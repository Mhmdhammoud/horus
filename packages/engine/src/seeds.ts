/**
 * Seed ranking (HOR-39). Search returns several candidate symbols for a vague hint;
 * we should not lock onto a tiny helper. Prefer architectural entry points
 * (resolver / controller / service / route / worker) over utils, scripts, and
 * legacy/migration code, and surface the ranked candidates with their role.
 */

import type { Symbol } from '@horus/core';

export interface RankedSeed {
  symbol: Symbol;
  score: number;
  role: string;
}

const PREFER =
  /resolver|controller|\bservice\b|route|router|handler|gateway|processor|worker|consumer|repository|usecase|use-case|endpoint/i;
const DEMOTE =
  /\butil|helper|\bscript|backfill|legacy|migration|seeder|fixture|\bmock\b|\btest\b|\bspec\b/i;

/** A coarse architectural role for display. */
export function seedRole(s: Symbol): string {
  const hay = `${s.name} ${s.filePath}`;
  if (/\.resolver\.|resolver/i.test(hay)) return 'resolver';
  if (/\.controller\.|controller/i.test(hay)) return 'controller';
  if (/\.service\.|service/i.test(hay)) return 'service';
  if (/processor|worker|consumer/i.test(hay)) return 'worker';
  if (/route|router|endpoint|handler|gateway/i.test(hay)) return 'route';
  if (/repository|\brepo\b/i.test(hay)) return 'repository';
  if (/(^|\/)scripts?\/|backfill|migration|seeder/i.test(hay)) return 'script';
  if (/util|helper/i.test(hay)) return 'util';
  return 'code';
}

/** Score a seed; higher = a more likely investigation entry point. */
export function scoreSeed(s: Symbol, index: number, hintTokens?: string[]): number {
  const hay = `${s.name} ${s.filePath}`.toLowerCase();
  let score = 0;
  if (PREFER.test(hay)) score += 3;
  if (DEMOTE.test(hay)) score -= 3;
  // Strong file-suffix signals.
  if (/\.(resolver|controller|service)\.[jt]sx?$/i.test(s.filePath)) score += 2;
  // Scripts/migrations are rarely the incident surface.
  if (/(^|\/)scripts?\//i.test(s.filePath)) score -= 2;
  // Mild tie-break toward earlier search rank (search relevance).
  score += Math.max(0, 5 - index) * 0.1;
  // Domain-hint boost: strongly prefer symbols whose name/path contain hint tokens.
  // +2 per matching token, capped at +6 so a 3-token match decisively beats a
  // generic architectural-role match (max architectural score is +5).
  if (hintTokens !== undefined && hintTokens.length > 0) {
    let hintBoost = 0;
    for (const tok of hintTokens) {
      if (hay.includes(tok)) {
        hintBoost += 2;
        if (hintBoost >= 6) break;
      }
    }
    score += hintBoost;
  }
  return score;
}

/** Rank seeds best-first. Stable for equal scores (preserves search order). */
export function rankSeeds(seeds: Symbol[], hintTokens?: string[]): RankedSeed[] {
  return seeds
    .map((symbol, i) => ({ symbol, score: scoreSeed(symbol, i, hintTokens), role: seedRole(symbol), i }))
    .sort((a, b) => (b.score === a.score ? a.i - b.i : b.score - a.score))
    .map(({ symbol, score, role }) => ({ symbol, score, role }));
}
