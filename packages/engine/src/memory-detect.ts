/**
 * Horus Memory M3 — auto-detection of memory→memory edges (`horus memory detect`).
 *
 * The detectors scan the authored substrate for two relationships between same-repo items and PROPOSE
 * typed edges for an operator to confirm:
 *   - `auto:recurrence`   → two items describe the same recurring pattern   (rel: `recurs-with`)
 *   - `auto:contradiction`→ two items make opposing claims                  (rel: `contradicts`)
 *
 * HONESTY INVARIANTS (spec §8) — load-bearing, asserted at every layer:
 *   - Auto-detectors are CONTEXT-ONLY. They PROPOSE edges; nothing here (or downstream of it) feeds
 *     the confidence/verdict scoring path. The `detection` label is recorded honestly on the edge's
 *     audit row, never folded into a score.
 *   - `contradicts` is a FLAG, never a deletion or an auto status-flip. A proposed contradiction edge
 *     records the conflict; it must NEVER cause either item to be forgotten or re-statused.
 *   - precedent never overrides live evidence; private targets never leak; vectors never sync.
 *
 * SEAM (Stage 1a): this module defines the {@link ProposedEdge} contract + the {@link detectMemoryEdges}
 * entry point the `memory detect` command calls. The concrete recurrence/contradiction heuristics are
 * filled by Stage 1b; the entry point is intentionally side-effect-free (it READS the store and the
 * vector index and RETURNS proposals — it never writes), so `--dry-run` is honored by construction.
 */

import type { MemoryStore, MemoryVectorIndex, MemoryRel } from './memory-store.js';

/** The two auto-detector provenance labels a proposed edge can carry (never `manual`/`structural`). */
export type AutoDetection = 'auto:recurrence' | 'auto:contradiction';

/**
 * A single proposed memory→memory edge. `fromMemoryId`/`toMemoryId` are both `memory_item` ids in the
 * SAME repo; `rel` is a FROZEN memory rel; `detection` is the auto-detector that proposed it; `reason`
 * is a short human-readable justification surfaced in the dry-run preview + recorded on the audit note.
 */
export interface ProposedEdge {
  fromMemoryId: string;
  toMemoryId: string;
  rel: MemoryRel;
  detection: AutoDetection;
  reason: string;
}

/** Inputs to {@link detectMemoryEdges}. `repo` is REQUIRED + fails closed (HOR-46). */
export interface DetectMemoryOpts {
  repo: string;
  /** Cap on items scanned (deterministic, bounded). */
  limit?: number;
}

/** Optional collaborators for detection. The vector index merely PROPOSES candidate neighbours. */
export interface DetectMemoryDeps {
  vectorIndex?: MemoryVectorIndex;
}

/**
 * Scan a repo's authored items and PROPOSE memory→memory edges. READ-ONLY: it never writes to the
 * store or the index, so the caller is free to print proposals (`--dry-run`) or persist them.
 *
 * Stage 1a ships the seam with a deterministic empty result (no proposals); Stage 1b fills in the
 * recurrence + contradiction heuristics. Fails closed on a blank repo (HOR-46).
 */
export async function detectMemoryEdges(
  store: MemoryStore,
  opts: DetectMemoryOpts,
  _deps: DetectMemoryDeps = {},
): Promise<ProposedEdge[]> {
  const repo = opts.repo.trim();
  if (repo === '') return []; // HOR-46 fail-closed — no repo identity proposes nothing

  // READ the substrate (the heuristics in Stage 1b operate over these rows + the vector index).
  // Touching the store keeps the seam's contract honest: detection is derived from stored context.
  await store.query({ repo, limit: opts.limit ?? 1000 });

  // Stage 1b fills the recurrence + contradiction detectors here. Until then there are no proposals.
  return [];
}
