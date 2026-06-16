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

// Runtime sources carry direct live observations — allow each to contribute up
// to 2.0 before the source cap kicks in.
const MAX_RUNTIME_CONTRIBUTION = 2.0;

// Structural sources (code graph symbols, flow edges, queue-edge topology)
// provide supporting context, not live confirmation. Cap them lower so a
// verbose code graph cannot saturate confidence the way runtime anomalies can.
const MAX_STRUCTURAL_CONTRIBUTION = 0.6;

// Ambient runtime evidence (runtime kind but not linked to the seed — see HOR-156)
// should not masquerade as confirmed signal. Cap it at the same level as structural
// so unrelated high-volume error noise cannot inflate confidence (HOR-158).
const MAX_AMBIENT_RUNTIME_CONTRIBUTION = 0.6;

// Normalize: 3 independent high-quality runtime sources at max contribution → 1.0.
const NORMALIZATION = 6;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Compute an evidence-quality confidence value (0–1) for a set of evidence.
 *
 * Each item contributes `clamp01(relevance) × (1.5 if runtime, else 0.5)`.
 * Contributions are accumulated separately for runtime and structural kinds,
 * each grouped by `Evidence.source`. Runtime sources are capped at
 * MAX_RUNTIME_CONTRIBUTION (2.0); structural sources at MAX_STRUCTURAL_CONTRIBUTION
 * (0.6). The two sums are then combined and normalised by 6.
 *
 * Separate caps ensure that a verbose code graph (many symbol/flow records)
 * cannot contribute as much as a runtime provider emitting live anomalies.
 *
 * @param ambientEvidenceIds - Optional set of evidence IDs classified as ambient
 *   (runtime kind but not linked to the seed symbol via seed terms or service
 *   match). Ambient evidence is weighted at 0.5 (like structural) and capped at
 *   MAX_AMBIENT_RUNTIME_CONTRIBUTION (0.6) per source. This prevents unrelated
 *   high-volume errors from inflating confidence as if they were confirmed signal
 *   (HOR-158).
 */
export function computeWeightedEvidenceConfidence(
  evidence: Evidence[],
  ambientEvidenceIds?: Set<string>,
): number {
  const runtimeBySource = new Map<string, number>();
  const ambientBySource = new Map<string, number>();
  const structuralBySource = new Map<string, number>();

  for (const e of evidence) {
    const r = clamp01(e.relevance);
    if (RUNTIME_KINDS.has(e.kind)) {
      if (ambientEvidenceIds?.has(e.id)) {
        // Ambient runtime evidence: no structural link to the seed established.
        // Weight and cap it like structural evidence so noise doesn't masquerade
        // as confirmed signal.
        ambientBySource.set(e.source, (ambientBySource.get(e.source) ?? 0) + 0.5 * r);
      } else {
        runtimeBySource.set(e.source, (runtimeBySource.get(e.source) ?? 0) + 1.5 * r);
      }
    } else {
      structuralBySource.set(e.source, (structuralBySource.get(e.source) ?? 0) + 0.5 * r);
    }
  }

  const runtimeSum = [...runtimeBySource.values()].reduce(
    (acc, w) => acc + Math.min(w, MAX_RUNTIME_CONTRIBUTION),
    0,
  );
  const ambientSum = [...ambientBySource.values()].reduce(
    (acc, w) => acc + Math.min(w, MAX_AMBIENT_RUNTIME_CONTRIBUTION),
    0,
  );
  const structuralSum = [...structuralBySource.values()].reduce(
    (acc, w) => acc + Math.min(w, MAX_STRUCTURAL_CONTRIBUTION),
    0,
  );

  return clamp01((runtimeSum + ambientSum + structuralSum) / NORMALIZATION);
}
