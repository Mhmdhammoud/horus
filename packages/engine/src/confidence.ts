/**
 * Weighted evidence confidence calculation (HOR-45).
 *
 * Pure function — no I/O, no randomness. Exported so it can be tested
 * independently from investigate(), avoiding gap-ceiling masking.
 */

import type { Evidence, EvidenceKind } from '@horus/core';

// Evidence kinds that come from live runtime observations.
// Structural code-graph kinds (symbol, flow, impact, queue-edge) are excluded.
const RUNTIME_KINDS = new Set<EvidenceKind>([
  'log',
  'metric',
  'commit',
  'queue-state',
  'redis-key',
  'state',
]);

// A single evidence source (provider) can contribute at most this much to
// the weighted sum. Prevents one verbose provider from saturating confidence
// regardless of how many derived records it emits.
const MAX_CONTRIBUTION_PER_SOURCE = 2.0;

// Normalize: 3 independent high-quality sources at max contribution → 1.0.
const NORMALIZATION = 6;

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Compute an evidence-quality confidence value (0–1) for a set of evidence.
 *
 * Each item contributes `clamp01(relevance) × (1.5 if runtime, else 0.5)`.
 * Contributions are grouped by `Evidence.source` and each source is capped
 * at `MAX_CONTRIBUTION_PER_SOURCE` before summing, so a single verbose
 * provider (many derived records from one snapshot) cannot saturate the result.
 *
 * Normalised by 6 — three independent high-quality runtime sources reach 1.0.
 */
export function computeWeightedEvidenceConfidence(evidence: Evidence[]): number {
  const sourceContributions = new Map<string, number>();
  for (const e of evidence) {
    const w = (RUNTIME_KINDS.has(e.kind) ? 1.5 : 0.5) * clamp01(e.relevance);
    sourceContributions.set(e.source, (sourceContributions.get(e.source) ?? 0) + w);
  }
  const cappedSum = [...sourceContributions.values()].reduce(
    (acc, w) => acc + Math.min(w, MAX_CONTRIBUTION_PER_SOURCE),
    0,
  );
  return clamp01(cappedSum / NORMALIZATION);
}
