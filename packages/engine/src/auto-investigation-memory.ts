/**
 * HOR-432 — auto-create a recurrence-aware memory from EVERY investigation.
 *
 * Every produced investigation report is captured as a durable `memory_item` (kind:`investigation`),
 * and — when it matches a prior investigation/incident-pattern in the same repo — linked to that prior
 * memory with a `recurs-with` edge. This turns the institutional-memory substrate into a self-building
 * record of what has been investigated and what recurs, without any human authoring step.
 *
 * HONESTY INVARIANTS (spec §8) — load-bearing, mirrored from memory-store.ts / memory-detect.ts:
 *   - The captured memory is CONTEXT-ONLY. Nothing here (or downstream of it) feeds the
 *     confidence/verdict scoring path. The memory stores the HONEST verdict — including unconfirmed/
 *     partly outcomes and the report's real `confidence` (NEVER inflated). A hypothesis is never
 *     upgraded to a fact: the claim records the top hypothesis as a hypothesis.
 *   - `recurs-with` is auto-detected (it merely RECORDS that two investigations look like the same
 *     pattern). `supersedes` is NEVER auto-detected — precedent never overrides live evidence.
 *   - HOR-46 fail-closed: a blank repo identity produces NO memory (never cross-repo).
 *
 * NON-BLOCKING: the caller (engine `investigate`) wraps every entry point here in try/catch so a
 * failure can NEVER block investigation delivery. These functions are best-effort by contract.
 */

import type { AuditCtx, MemoryItem, MemoryStore, NewMemoryItem } from './memory-store.js';
import type { InvestigationReport } from './types.js';
import { deriveSignature, deriveTags } from './memory.js';
import { recurrenceEdgeId, recurrenceReason } from './memory-detect.js';

/** Max prior memories scanned for a recurrence match (deterministic, bounded). */
const RECURRENCE_SCAN_LIMIT = 100;

/** Trim + cap a free-text fragment so the auto claim stays a concise one-liner. */
function snippet(text: string, max = 140): string {
  const s = text.trim().replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Default-ON env gate. The user wants EVERY investigation to create a memory, so the feature is on
 * unless `HORUS_AUTO_INVESTIGATION_MEMORY` is explicitly set to `0`/`false` (the escape hatch).
 */
export function autoInvestigationMemoryEnabled(): boolean {
  const v = (process.env.HORUS_AUTO_INVESTIGATION_MEMORY ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/**
 * Build + persist a `kind:investigation` memory from a finished report, with an `about-incident` link
 * back to the source investigation. Returns the persisted item, or `null` when there is no repo
 * identity (HOR-46 fail-closed — a memory is never created for a blank repo).
 *
 * HONESTY: `confidence` is the report's real confidence (never inflated); the claim names the top
 * hypothesis as a hypothesis (never as a confirmed fact). The signature/tags are the SAME deterministic
 * incident-family keys used by `incident_memory`, so this memory recurs identically.
 */
export async function createInvestigationMemory(
  store: MemoryStore,
  investigationId: string | null,
  report: InvestigationReport,
  audit: AuditCtx,
): Promise<MemoryItem | null> {
  // HOR-46 fail-closed: blank/whitespace repo is treated as missing → no memory.
  const repo = report.input.repo?.trim() || null;
  if (repo === null) return null;

  const hint = report.input.hint;
  const topHyp = report.hypotheses[0];
  // The headline is the top hypothesis (recorded AS a hypothesis), falling back to the summary.
  const headline =
    topHyp !== undefined
      ? snippet(topHyp.statement || topHyp.category || report.summary)
      : snippet(report.summary || '(no leading hypothesis)');

  const claim = `Investigation: ${snippet(hint)} -> ${headline}`;

  const item: NewMemoryItem = {
    id: '',
    kind: 'investigation',
    source: 'investigation',
    scope: 'repo',
    visibility: 'private',
    // HONEST confidence — the report's own value, never inflated.
    confidence: report.confidence,
    claim,
    repo,
    evidence: [],
    // Incident-family recall keys (same derivation as incident_memory) so this memory recurs.
    signature: deriveSignature(report),
    tags: deriveTags(report),
    payload: {
      investigationId,
      hint,
      topHypothesis: topHyp !== undefined ? (topHyp.category ?? null) : null,
    },
  };

  const created = await store.add(item, audit);

  // about-incident link back to the source investigation (a derived, structural relationship).
  if (investigationId !== null && investigationId.trim() !== '') {
    await store.addLink(
      {
        id: '',
        fromMemoryId: created.id,
        rel: 'about-incident',
        toKind: 'incident',
        toRef: investigationId,
      },
      { detection: 'structural', audit },
    );
  }

  return created;
}

/**
 * Find a prior memory in the SAME repo that this new investigation memory recurs with, or `null`.
 *
 * Scans existing `investigation`/`incident-pattern` items (bounded) and REUSES the conservative
 * matching logic from `memory-detect.ts` (`recurrenceReason`: identical usable signature, OR tag
 * overlap ≥0.6 with ≥1 non-generic shared tag, OR a corroborated claim-text fallback). Returns the
 * first matching memory's id (the existing items come back newest-first, so the most recent recurrence
 * wins). Fails closed on a blank repo (HOR-46). CONTEXT-ONLY: read seam only.
 */
export async function detectRecurrence(
  store: MemoryStore,
  newItem: MemoryItem,
  repo: string,
): Promise<string | null> {
  const r = repo.trim();
  if (r === '') return null; // HOR-46 fail-closed

  const existing = await store.query({
    repo: r,
    kind: ['investigation', 'incident-pattern'],
    limit: RECURRENCE_SCAN_LIMIT,
  });

  for (const candidate of existing) {
    if (candidate.id === newItem.id) continue; // never match the just-written item
    if (recurrenceReason(candidate, newItem) !== null) return candidate.id;
  }
  return null;
}

/**
 * Author a `recurs-with` edge between the new investigation memory and a matching prior memory. The
 * pair is canonicalized (lo→hi by id) and the edge id is the resync-stable {@link recurrenceEdgeId},
 * so re-running (or re-syncing) NEVER mints a duplicate — the store dedupes on the canonical id.
 *
 * HONESTY: a `recurs-with` edge RECORDS recurrence only; it never flips status or feeds scoring.
 */
export async function linkRecurrence(
  store: MemoryStore,
  newId: string,
  existingId: string,
  investigationId: string | null,
): Promise<void> {
  if (newId === existingId) return; // never self-link
  const [lo, hi] = newId <= existingId ? [newId, existingId] : [existingId, newId];
  await store.addLink(
    {
      id: recurrenceEdgeId(newId, existingId),
      fromMemoryId: lo,
      rel: 'recurs-with',
      toKind: 'memory',
      toRef: hi,
    },
    {
      detection: 'auto:investigation-recurrence',
      audit: { actor: { kind: 'system' }, note: 'auto: investigation recurrence (HOR-432)' },
      ...(investigationId !== null ? { detail: { investigationId } } : {}),
    },
  );
}
