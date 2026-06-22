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
// Type/DTO/interface declarations are not where a fault ORIGINATES — the fault lives
// in the method that throws, not the result/input type it returns or the interface it
// implements. Detect type-declaration naming conventions so a same-named method
// outranks a `…Result`/`…Input`/interface, and so the engine can re-search for the
// executable counterpart (HOR-337). (A full kind-based version via Symbol.kind from
// the graph label is the more complete follow-up; this name heuristic covers the
// common DTO/result-type collisions seen in practice.)
const TYPE_SUFFIX = /(Result|Input|Response|Payload|Args|Dto|Props|Edge|Connection)$/;
const INTERFACE_PREFIX = /^I(?=[A-Z][a-z])/;
const TYPE_LIKE_NAME = new RegExp(`(?:${TYPE_SUFFIX.source})|(?:${INTERFACE_PREFIX.source})`);

/** True when a symbol NAME follows type/DTO/interface declaration conventions. */
export function isTypeLikeName(name: string): boolean {
  return TYPE_LIKE_NAME.test(name);
}

/**
 * Derive the executable counterpart name for a type-like name, or null.
 * e.g. "SyncBrandFulfillmentsResult" -> "SyncBrandFulfillments"; "IOrderService" -> "OrderService".
 */
export function executableBaseName(name: string): string | null {
  const stripped = name.replace(TYPE_SUFFIX, '').replace(INTERFACE_PREFIX, '');
  return stripped !== name && stripped.length >= 4 ? stripped : null;
}

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
export function scoreSeed(
  s: Symbol,
  index: number,
  hintTokens?: string[],
  changedFiles?: Set<string>,
): number {
  const hay = `${s.name} ${s.filePath}`.toLowerCase();
  let score = 0;
  if (PREFER.test(hay)) score += 3;
  if (DEMOTE.test(hay)) score -= 3;
  // Demote type/DTO/interface-named symbols so an executable method wins a same-name
  // collision (HOR-337). Methods are verbs (syncProduct); types are nouns (…Result).
  if (isTypeLikeName(s.name)) score -= 4;
  // Demote thin getters/passthroughs (a few lines): the fault lives in the substantive
  // method they delegate to, not a 4-line field-resolver/getter that merely string-matches
  // the hint (HOR-337 follow-up — a getter must not outrank the real service).
  if (s.startLine !== undefined && s.endLine !== undefined && s.endLine - s.startLine <= 3) {
    score -= 3;
  }
  // Regression investigations (--since): a candidate that lives in a file changed in the
  // window is far more likely to be the culprit. Strong boost so the seed follows the diff
  // instead of locking onto an unrelated unchanged function (HOR-328 round-3).
  if (changedFiles !== undefined && changedFiles.has(s.filePath)) score += 5;
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
export function rankSeeds(
  seeds: Symbol[],
  hintTokens?: string[],
  changedFiles?: Set<string>,
): RankedSeed[] {
  return seeds
    .map((symbol, i) => ({
      symbol,
      score: scoreSeed(symbol, i, hintTokens, changedFiles),
      role: seedRole(symbol),
      i,
    }))
    .sort((a, b) => (b.score === a.score ? a.i - b.i : b.score - a.score))
    .map(({ symbol, score, role }) => ({ symbol, score, role }));
}
