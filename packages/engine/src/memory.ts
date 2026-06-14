/**
 * HOR-18 — Deterministic incident memory & pattern recognition.
 *
 * Stores past investigations as tagged + signed memory rows, and recalls
 * similar past incidents via Jaccard overlap on tags. NO vectors / embeddings.
 * Past incidents are CONTEXT ONLY — they must never override current evidence.
 */

import type { InvestigationReport } from './types.js';
import type { HorusDb } from '@horus/db';
import { incidentMemory } from '@horus/db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SimilarIncident {
  investigationId: string | null;
  title: string;
  summary: string | null;
  /** Jaccard overlap score (0..1). */
  overlap: number;
  sharedTags: string[];
}

// ---------------------------------------------------------------------------
// Tag / signature derivation
// ---------------------------------------------------------------------------

/**
 * Derive the "module area" from a file path: up to the first 3 path segments.
 * e.g. 'src/modules/zoho/zoho.service.ts' -> 'src/modules/zoho'
 *      'a.ts'                              -> 'a.ts'
 */
export function moduleArea(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.replace(/^\//, '').split('/');
  // Guard: if the path has 3 or fewer segments, return the whole thing.
  if (parts.length <= 3) return filePath;
  // Take only the first 3 segments.
  return parts.slice(0, 3).join('/');
}

/**
 * Derive a deterministic, lowercase tag set from an InvestigationReport.
 *
 * Sources:
 *   - Queue names from timeline boundary crossings
 *   - Top hypothesis category
 *   - Module area of the first seed's filePath
 *   - input.service
 *
 * Guards all indexed access (noUncheckedIndexedAccess).
 */
export function deriveTags(r: InvestigationReport): string[] {
  const raw: string[] = [];

  // Queue names from boundary crossings.
  for (const bc of r.timeline.boundaryCrossings) {
    if (bc.queueName) raw.push(bc.queueName);
  }

  // Top hypothesis category.
  const topHyp = r.hypotheses[0];
  if (topHyp !== undefined && topHyp.category) {
    raw.push(topHyp.category);
  }

  // Module area of the first seed's filePath.
  const firstSeed = r.seeds[0];
  if (firstSeed !== undefined && firstSeed.filePath) {
    const area = moduleArea(firstSeed.filePath);
    if (area) raw.push(area);
  }

  // Optional service scoping.
  if (r.input.service) {
    raw.push(r.input.service);
  }

  // Lowercase, deduplicate, filter empty.
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of raw) {
    const lower = t.toLowerCase();
    if (lower && !seen.has(lower)) {
      seen.add(lower);
      tags.push(lower);
    }
  }
  return tags;
}

/**
 * Derive a compact, deterministic signature string from an InvestigationReport.
 * Format: '<area>|<topHypCategory>|<sortedQueues>'
 */
export function deriveSignature(r: InvestigationReport): string {
  const firstSeed = r.seeds[0];
  const area = firstSeed !== undefined ? moduleArea(firstSeed.filePath ?? '') : '';

  const topHyp = r.hypotheses[0];
  const topHypCategory = topHyp !== undefined ? (topHyp.category ?? '') : '';

  const queues = r.timeline.boundaryCrossings
    .map((bc) => bc.queueName)
    .filter(Boolean)
    .sort()
    .join(',');

  return [area, topHypCategory, queues].join('|');
}

/** Hypothesis-category tags — generic, shared by many unrelated incidents. */
const GENERIC_HYPOTHESIS_TAGS = new Set([
  'queue-backlog',
  'worker-slowdown',
  'external-api-latency',
  'deployment-regression',
  'retry-storm',
  'infrastructure',
]);

/** True for tags too generic to imply two incidents are actually related. */
export function isGenericTag(tag: string): boolean {
  return (
    GENERIC_HYPOTHESIS_TAGS.has(tag) ||
    /(^|-)(prod|production|staging|dev|local)$/.test(tag)
  );
}

// ---------------------------------------------------------------------------
// Jaccard tag overlap
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity: |intersection| / |union|, clamped to 0..1.
 * Returns 0 when the union is empty.
 */
export function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersectionCount = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersectionCount++;
  }

  const unionCount = setA.size + setB.size - intersectionCount;
  if (unionCount === 0) return 0;
  return intersectionCount / unionCount;
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/**
 * Read up to ~200 incident_memory rows and return the top-3 most similar
 * (by Jaccard overlap) that are NOT the current investigation.
 *
 * Past incidents are CONTEXT ONLY — callers must not modify report.confidence.
 */
export async function recallSimilar(
  db: HorusDb,
  tags: string[],
  excludeInvestigationId: string | null,
): Promise<SimilarIncident[]> {
  try {
    const rows = await db.select().from(incidentMemory).limit(200);

    const candidates: SimilarIncident[] = [];
    const tagSet = new Set(tags);
    for (const row of rows) {
      // Skip the current investigation.
      if (
        excludeInvestigationId !== null &&
        row.investigationId === excludeInvestigationId
      ) {
        continue;
      }

      const rowTags = row.tags ?? [];
      const overlap = tagOverlap(tags, rowTags);
      if (overlap <= 0) continue;

      const sharedTags = rowTags.filter((t) => tagSet.has(t));
      // A match is only meaningful if it shares a SPECIFIC tag (a symbol/file/queue/
      // module), not just generic hypothesis categories or env/service labels (HOR-39).
      if (sharedTags.every((t) => isGenericTag(t))) continue;

      candidates.push({
        investigationId: row.investigationId,
        title: row.title,
        summary: row.summary,
        overlap,
        sharedTags,
      });
    }

    // Deduplicate by title (the same incident may have been investigated repeatedly),
    // keeping the best-overlap representative; then take the top 3 distinct incidents.
    const byTitle = new Map<string, SimilarIncident>();
    for (const c of candidates) {
      const existing = byTitle.get(c.title);
      if (existing === undefined || c.overlap > existing.overlap) {
        byTitle.set(c.title, c);
      }
    }
    return [...byTitle.values()].sort((a, b) => b.overlap - a.overlap).slice(0, 3);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Persist a memory row for the current investigation. Non-fatal — a DB failure
 * here never throws and never prevents the report from being returned.
 */
export async function storeIncidentMemory(
  db: HorusDb,
  investigationId: string | null,
  r: InvestigationReport,
): Promise<void> {
  try {
    const topHyp = r.hypotheses[0];
    await db.insert(incidentMemory).values({
      investigationId,
      title: r.input.hint,
      summary: r.summary,
      signature: deriveSignature(r),
      tags: deriveTags(r),
      payload: {
        confidence: r.confidence,
        topHypothesis: topHyp !== undefined ? (topHyp.category ?? null) : null,
        queues: r.timeline.boundaryCrossings.map((b) => b.queueName),
      },
    });
  } catch {
    // Non-fatal — institutional memory must never prevent report delivery.
  }
}
