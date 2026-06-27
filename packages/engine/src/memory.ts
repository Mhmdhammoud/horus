/**
 * HOR-18 — Deterministic incident memory & pattern recognition.
 *
 * Stores past investigations as tagged + signed memory rows, and recalls
 * similar past incidents via Jaccard overlap on tags. NO vectors / embeddings.
 * Past incidents are CONTEXT ONLY — they must never override current evidence.
 */

import type { InvestigationReport } from './types.js';
import type {
  HorusDb,
  MemoryItem,
  NewMemoryItem,
  MemoryLink,
  NewMemoryLink,
  MemoryAudit,
} from '@horus/db';
import {
  incidentMemory,
  memoryItem,
  memoryLink,
  memoryAudit,
  eq,
  and,
  or,
  desc,
} from '@horus/db';
import type {
  MemoryStore,
  MemoryQuery,
  AuditCtx,
  MemoryStatus,
  Visibility,
  Rel,
} from './memory-store.js';

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
 * Read up to ~200 incident_memory rows scoped to the given project and return
 * the top-3 most similar (by Jaccard overlap) that are NOT the current investigation.
 *
 * Fails closed: returns [] when project is null so investigations without a
 * repo identity never receive another project's memories (HOR-46).
 * A second in-memory project check guards against DB-layer misses.
 *
 * Past incidents are CONTEXT ONLY — callers must not modify report.confidence.
 */
export async function recallSimilar(
  db: HorusDb,
  tags: string[],
  excludeInvestigationId: string | null,
  project: string | null,
): Promise<SimilarIncident[]> {
  // Normalize: treat blank/whitespace as missing, then fail closed.
  const p = project?.trim() || null;
  if (p === null) return [];

  try {
    const rows = await db
      .select()
      .from(incidentMemory)
      .where(eq(incidentMemory.project, p))
      .limit(200);

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

      // Defense in depth: skip rows from other projects even if the DB query leaked them.
      if (row.project !== p) continue;

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
 * Skips storage when no project identity is available (HOR-46).
 */
export async function storeIncidentMemory(
  db: HorusDb,
  investigationId: string | null,
  r: InvestigationReport,
): Promise<void> {
  // Normalize then fail closed: blank/whitespace repo is treated as missing.
  const project = r.input.repo?.trim() || null;
  if (project === null) return;

  try {
    const topHyp = r.hypotheses[0];
    await db.insert(incidentMemory).values({
      investigationId,
      project,
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

// ---------------------------------------------------------------------------
// PII / secret gate (spec §7 privacy)
// ---------------------------------------------------------------------------

/**
 * Thrown when a claim contains an obvious secret/credential. The add/confirm path REJECTS rather
 * than silently storing — a memory claim is durable, user-controllable, and (later) cloud-syncable,
 * so credentials must never enter it (spec §7).
 */
export class MemorySecretError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`refusing to store memory claim: detected ${kind}`);
    this.name = 'MemorySecretError';
    this.kind = kind;
  }
}

/**
 * Obvious-secret detectors for the claim gate. These mirror the credential class of
 * `@horus/core`'s redaction patterns but are non-global + labelled so a single match can be
 * reported. PII like bare emails/IPs is intentionally NOT rejected here (it does not block a claim
 * in M1); only high-confidence credentials/keys do.
 */
const CLAIM_SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'private-key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { label: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'gcp-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { label: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { label: 'auth-header', re: /authorization\s*[=:]\s*(?:bearer|basic)\s+\S+/i },
  {
    label: 'credential-kv',
    re: /"?(?:password|passwd|secret|token|api[_-]?key|apikey|x-api-key)"?\s*[=:]\s*"?[^"',\s)>]+/i,
  },
  {
    label: 'connection-string-creds',
    re: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/[^:@/\s]+:[^@\s]+@/i,
  },
  { label: 'card-number', re: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/ },
];

/** Return a label for the first obvious secret found in `claim`, or null when it is clean. */
export function detectClaimSecret(claim: string): string | null {
  for (const { label, re } of CLAIM_SECRET_PATTERNS) {
    if (re.test(claim)) return label;
  }
  return null;
}

/** Throw `MemorySecretError` if the claim carries an obvious secret/credential. */
function assertClaimClean(claim: string): void {
  const found = detectClaimSecret(claim);
  if (found !== null) throw new MemorySecretError(found);
}

// ---------------------------------------------------------------------------
// createLocalMemoryStore — drizzle/Postgres impl of the MemoryStore seam (M1, spec §6)
// ---------------------------------------------------------------------------

/** Stable, prefixed id for a memory row. ULID-shaped is unnecessary in M1; a UUID suffices. */
function genId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

/** M1 link relations with concrete resolvers — memory→memory rels are deferred (spec cut). */
const M1_RELS: ReadonlySet<Rel> = new Set<Rel>([
  'about-symbol',
  'about-file',
  'has-evidence',
  'about-incident',
]);

/** Map a target status onto the audit action that produced it (user-facing provenance). */
function statusAction(status: MemoryStatus): string {
  switch (status) {
    case 'forgotten':
      return 'forget';
    case 'pinned':
      return 'pin';
    case 'possibly-stale':
      return 'mark-stale';
    case 'deprecated':
      return 'deprecate';
    case 'contradicted':
      return 'contradict';
    case 'fresh':
      return 'confirm';
    default:
      return 'set-status';
  }
}

/**
 * Local (drizzle/Postgres, embedded pglite by default) implementation of the `MemoryStore` seam.
 *
 * - The existing incident-recall methods (`recall`/`record`/`loadScoped`) stay backed by
 *   `incident_memory` and reuse the pure helpers above, so the ~12 incident-memory tests are
 *   unaffected (additive).
 * - The authored substrate (`add`/`get`/`query`/`setStatus`/`setVisibility`/`verify`/`addLink`/
 *   `links`/`history`) is backed by `memory_item`/`memory_link`/`memory_audit`.
 *
 * Invariants:
 *   - HOR-46 fail-closed: every `memory_item` requires a `repo`; `query` returns nothing for a
 *     blank repo and filters defensively against leaking another repo's rows.
 *   - Soft-forget: `setStatus(id, 'forgotten')` flips status only — the row is retained and the
 *     transition is audited, so forgetting is reversible.
 *   - Append-only audit: every mutation writes a `memory_audit` row; `history()` returns the trail.
 *   - PII/secret gate (spec §7): `add` and `verify` reject claims carrying obvious secrets.
 *   - Confirmed-outcome stays `private`: a `confirmed-outcome` item is never auto-promoted to team.
 *
 * HONESTY INVARIANT (spec §8): this is storage only. Nothing here is read by the confidence/verdict
 * scoring path.
 */
export function createLocalMemoryStore(db: HorusDb): MemoryStore {
  const getById = async (id: string): Promise<MemoryItem | null> => {
    const rows = await db.select().from(memoryItem).where(eq(memoryItem.id, id)).limit(1);
    return rows[0] ?? null;
  };

  const appendAudit = async (a: {
    memoryId: string;
    action: string;
    actor: AuditCtx['actor'];
    fromStatus: string | null;
    toStatus: string | null;
    note: string | null;
  }): Promise<void> => {
    await db.insert(memoryAudit).values({
      id: genId('aud'),
      memoryId: a.memoryId,
      action: a.action,
      actor: a.actor,
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      note: a.note,
    });
  };

  return {
    // ---- existing incident-recall seam (map #4) — unchanged, backed by incident_memory ----
    recall(i) {
      return recallSimilar(db, i.tags, i.excludeInvestigationId, i.project);
    },
    record(i) {
      return storeIncidentMemory(db, i.investigationId, i.report);
    },
    async loadScoped(i) {
      const p = i.project.trim();
      if (p === '') return [];
      try {
        const rows = await db
          .select()
          .from(incidentMemory)
          .where(eq(incidentMemory.project, p))
          .limit(200);
        const tagSet = new Set(i.tokens);
        return rows.filter((row) => {
          if (row.project !== p) return false; // defense in depth
          const rowTags = row.tags ?? [];
          if (tagOverlap(i.tokens, rowTags) <= 0) return false;
          const shared = rowTags.filter((t) => tagSet.has(t));
          // Only meaningful if it shares a SPECIFIC tag, not generic categories/env labels (HOR-39).
          if (shared.length > 0 && shared.every((t) => isGenericTag(t))) return false;
          return true;
        });
      } catch {
        return [];
      }
    },

    // ---- MemoryItem substrate (new) — backed by memory_item/_link/_audit ----
    async add(item: NewMemoryItem, audit: AuditCtx): Promise<MemoryItem> {
      // Gate first — a claim carrying a secret must never be persisted (spec §7).
      assertClaimClean(item.claim);

      const repo = (item.repo ?? '').trim();
      if (repo === '') throw new Error('memory_item requires a repo (HOR-46 fail-closed)');

      const id = (item.id ?? '').trim() || genId('mem');
      const status = item.status ?? 'fresh';
      // Confirmed-outcome items stay private; never auto-promote to team (spec §7).
      const isConfirmedOutcome =
        item.source === 'confirmed-outcome' || item.kind === 'confirmed-outcome';
      const visibility = isConfirmedOutcome ? 'private' : (item.visibility ?? 'private');

      const inserted = await db
        .insert(memoryItem)
        .values({ ...item, id, repo, status, visibility })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new Error('memory_item insert returned no row');

      await appendAudit({
        memoryId: id,
        action: 'add',
        actor: audit.actor,
        fromStatus: null,
        toStatus: status,
        note: audit.note ?? null,
      });
      return row;
    },

    get: getById,

    async query(q: MemoryQuery): Promise<MemoryItem[]> {
      const repo = q.repo.trim();
      if (repo === '') return []; // HOR-46 fail-closed — no repo identity sees nothing

      const conds = [eq(memoryItem.repo, repo)];
      if (q.scope !== undefined) conds.push(eq(memoryItem.scope, q.scope));
      if (q.visibility !== undefined) conds.push(eq(memoryItem.visibility, q.visibility));
      if (q.orgId !== undefined) conds.push(eq(memoryItem.orgId, q.orgId));
      if (q.workspaceId !== undefined) conds.push(eq(memoryItem.workspaceId, q.workspaceId));
      if (q.userId !== undefined) conds.push(eq(memoryItem.userId, q.userId));
      if (q.status && q.status.length > 0) {
        const ors = q.status.map((s) => eq(memoryItem.status, s));
        conds.push(ors.length === 1 ? ors[0]! : or(...ors)!);
      }
      if (q.kind && q.kind.length > 0) {
        const ors = q.kind.map((k) => eq(memoryItem.kind, k));
        conds.push(ors.length === 1 ? ors[0]! : or(...ors)!);
      }

      let rows = await db
        .select()
        .from(memoryItem)
        .where(and(...conds))
        // Deterministic: newest first, id as the stable tie-break.
        .orderBy(desc(memoryItem.createdAt), memoryItem.id);

      rows = rows.filter((r) => r.repo === repo); // defense in depth (never leak another repo)
      if (q.limit !== undefined && q.limit > 0) rows = rows.slice(0, Math.floor(q.limit));
      return rows;
    },

    async setStatus(id: string, status: MemoryStatus, audit: AuditCtx): Promise<void> {
      const current = await getById(id);
      if (current === null) throw new Error(`memory item not found: ${id}`);
      await db.update(memoryItem).set({ status }).where(eq(memoryItem.id, id));
      await appendAudit({
        memoryId: id,
        action: statusAction(status),
        actor: audit.actor,
        fromStatus: current.status,
        toStatus: status,
        note: audit.note ?? null,
      });
    },

    async setVisibility(id: string, v: Visibility, audit: AuditCtx): Promise<void> {
      const current = await getById(id);
      if (current === null) throw new Error(`memory item not found: ${id}`);
      await db.update(memoryItem).set({ visibility: v }).where(eq(memoryItem.id, id));
      await appendAudit({
        memoryId: id,
        action: 'set-visibility',
        actor: audit.actor,
        fromStatus: null,
        toStatus: null,
        note: audit.note ?? `visibility -> ${v}`,
      });
    },

    async verify(
      id: string,
      snap: { lastVerifiedHash: string | null },
      audit: AuditCtx,
    ): Promise<void> {
      const current = await getById(id);
      if (current === null) throw new Error(`memory item not found: ${id}`);
      // Re-scan at confirm time (defense in depth — covers items added before the gate existed).
      assertClaimClean(current.claim);
      // Confirm resets possibly-stale -> fresh (spec §5). Other statuses are left untouched:
      // pinned stays pinned; forgotten/deprecated/contradicted are not silently resurrected.
      const nextStatus: MemoryStatus =
        current.status === 'possibly-stale' ? 'fresh' : (current.status as MemoryStatus);
      await db
        .update(memoryItem)
        .set({
          lastVerifiedHash: snap.lastVerifiedHash,
          lastVerifiedAt: new Date(),
          status: nextStatus,
        })
        .where(eq(memoryItem.id, id));
      await appendAudit({
        memoryId: id,
        action: 'verify',
        actor: audit.actor,
        fromStatus: current.status,
        toStatus: nextStatus,
        note: audit.note ?? null,
      });
    },

    async addLink(link: NewMemoryLink): Promise<void> {
      if (!M1_RELS.has(link.rel as Rel)) {
        throw new Error(`unsupported memory_link rel in M1: ${link.rel}`);
      }
      const id = (link.id ?? '').trim() || genId('lnk');
      await db.insert(memoryLink).values({ ...link, id });
    },

    async links(id: string, opts?: { rels?: Rel[] }): Promise<MemoryLink[]> {
      const conds = [eq(memoryLink.fromMemoryId, id)];
      if (opts?.rels && opts.rels.length > 0) {
        const ors = opts.rels.map((r) => eq(memoryLink.rel, r));
        conds.push(ors.length === 1 ? ors[0]! : or(...ors)!);
      }
      return db
        .select()
        .from(memoryLink)
        .where(and(...conds))
        .orderBy(memoryLink.createdAt, memoryLink.id);
    },

    async history(id: string): Promise<MemoryAudit[]> {
      return db
        .select()
        .from(memoryAudit)
        .where(eq(memoryAudit.memoryId, id))
        // Most-recent-first; id as the stable tie-break for same-instant rows.
        .orderBy(desc(memoryAudit.at), desc(memoryAudit.id));
    },
  };
}
