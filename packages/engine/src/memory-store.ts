/**
 * Horus Memory — the MemoryStore seam (M1, spec §6).
 *
 * Engine-domain interfaces for the authored-memory substrate. This file is a PURE seam:
 * it defines the `MemoryStore` + `MemoryVectorIndex` interfaces and the domain types, re-using
 * the @horus/db row types as the wire shapes — NO drizzle, NO cloud, NO HTTP imports here. The
 * concrete `createLocalMemoryStore(db)` (drizzle bodies) and `SourceMemoryVectorIndex` (Python
 * bridge) live outside the engine; only the deterministic `NoopVectorIndex` ships here so the
 * engine has a self-contained, zero-dependency fallback.
 *
 * HONESTY INVARIANT (spec §8): memory is CONTEXT ONLY. Nothing in this module is read by the
 * confidence/verdict scoring path. In M1 the vector index is the Jaccard/scope `NoopVectorIndex`
 * only — there are NO embeddings. The index merely PROPOSES candidates; the deterministic store
 * filter/rank (later) is the sole authority on what surfaces.
 */

import type {
  IncidentMemory,
  MemoryItem,
  NewMemoryItem,
  MemoryLink,
  NewMemoryLink,
  MemoryAudit,
} from '@horus/db';
import type { SimilarIncident } from './memory.js';
import type { InvestigationReport } from './types.js';
import { tagOverlap } from './memory.js';

// Re-export the @horus/db row types so callers depend on the engine seam, not drizzle directly.
export type { MemoryItem, NewMemoryItem, MemoryLink, NewMemoryLink, MemoryAudit };

// ---------------------------------------------------------------------------
// Domain enums / value types
// ---------------------------------------------------------------------------

/** Lifecycle status of a MemoryItem (spec §2). `forgotten` is a SOFT delete — row is retained. */
export type MemoryStatus =
  | 'fresh'
  | 'possibly-stale'
  | 'contradicted'
  | 'deprecated'
  | 'pinned'
  | 'forgotten';

/** Visibility scope. `team` activates for cloud/multi-tenant later; M1 stays `private`. */
export type Visibility = 'private' | 'team';

/** Authored-item kind (validated in TS, stored as text). */
export type MemoryKind =
  | 'code-fact'
  | 'contract'
  | 'decision'
  | 'pitfall'
  | 'incident-pattern'
  | 'confirmed-outcome'
  // HOR-432: an auto-captured record of a single investigation (the honest verdict, incl.
  // unconfirmed/partly). Carries an incident-family signature/tags so it participates in recurrence
  // detection. CONTEXT-ONLY — never read by the confidence/verdict scoring path.
  | 'investigation';

/** Provenance of a MemoryItem. */
export type MemorySource = 'derived' | 'human' | 'confirmed-outcome' | 'investigation';

/**
 * Link relation. The four M1 rels have concrete code/incident/evidence resolvers; the M3 memory→
 * memory graph adds `supersedes`/`contradicts`/`recurs-with` (always with `toKind:'memory'`).
 *
 * FROZEN CONTRACT (day-0): the memory-rel vocabulary is exactly supersedes|contradicts|recurs-with.
 * HONESTY INVARIANT (spec §8): these edges are CONTEXT ONLY. `contradicts` is a FLAG, never an
 * auto-deletion or auto status-flip; precedent (`supersedes`) never overrides live evidence.
 */
export type Rel =
  | 'about-symbol'
  | 'about-file'
  | 'has-evidence'
  | 'about-incident'
  | 'supersedes'
  | 'contradicts'
  | 'recurs-with';

/** The memory→memory rel subset — every one of these REQUIRES `toKind:'memory'`. */
export type MemoryRel = 'supersedes' | 'contradicts' | 'recurs-with';

/** Target kind a link points at. `memory` is the M3 memory→memory target. */
export type LinkTargetKind = 'node' | 'incident' | 'evidence' | 'memory';

/**
 * How an edge was produced — a NON-OPTIONAL, honest provenance label recorded in the link audit.
 * `manual` is human/agent-authored; the `auto:*` detectors are CONTEXT-ONLY (they propose edges and
 * NEVER feed the confidence/verdict scoring path); `structural` is a derived graph relationship.
 */
export type LinkDetection =
  | 'manual'
  | 'auto:recurrence'
  | 'auto:contradiction'
  // HOR-432: a `recurs-with` edge authored automatically when a freshly-captured investigation memory
  // matches a prior one. CONTEXT-ONLY — it records the recurrence, never feeds confidence/verdict.
  | 'auto:investigation-recurrence'
  // HOR-432: the audit provenance stamped when a recurring investigation is CONSOLIDATED into its
  // existing memory IN PLACE (bump count + refresh latest finding) rather than minting a duplicate.
  // CONTEXT-ONLY — it records the consolidation, never feeds confidence/verdict scoring.
  | 'auto:recurrence-consolidate'
  | 'structural';

/** Per-edge traversal direction relative to the queried item (`out` = authored from it). */
export type LinkDirection = 'out' | 'in';

/** Direction selector for {@link MemoryStore.links}; `both` (the memory-rel default) unions in+out. */
export type LinkDirectionFilter = 'out' | 'in' | 'both';

/** A persisted edge annotated with its direction relative to the item it was read for. */
export interface AnnotatedMemoryLink extends MemoryLink {
  direction: LinkDirection;
}

/** Options for {@link MemoryStore.addLink}. `detection` defaults to `manual`; `audit` is the actor/note. */
export interface AddLinkOpts {
  detection?: LinkDetection;
  audit?: AuditCtx;
  /**
   * Extra structured provenance merged into the edge's `link` audit detail (e.g. an
   * `auto:contradiction` edge carries the two source `investigationIds`). HONESTY: this is recorded
   * context only — it is never read by the confidence/verdict scoring path.
   */
  detail?: Record<string, unknown>;
}

/**
 * The unordered endpoints + relation that identify a memory→memory edge to remove. Only the FROZEN
 * memory rels are addressable (the M1 code/incident/evidence edges are derived, not hand-managed).
 * `recurs-with` is canonicalized on removal too, so either orientation matches the one stored row.
 */
export interface RemoveLinkSpec {
  fromMemoryId: string;
  rel: MemoryRel;
  toRef: string;
}

/** Options for {@link MemoryStore.removeLink}. `audit` is the actor/note recorded on the `unlink` row. */
export interface RemoveLinkOpts {
  audit?: AuditCtx;
}

/**
 * The mutable authored fields {@link MemoryStore.update} may refresh IN PLACE. Every field is
 * optional — an absent field is left untouched. `payload` is the additive, schema-free extension blob
 * (HOR-432 stashes `recurrenceCount`/`lastSeenAt`/`investigationIds` here). Status is DELIBERATELY not
 * updatable through this path — status transitions go through `setStatus`, never a field refresh.
 */
export interface MemoryUpdate {
  claim?: string;
  confidence?: number;
  payload?: Record<string, unknown> | null;
}

/**
 * Options for {@link MemoryStore.update}. `audit` is required (every mutation is audited). `action` is
 * the audit action recorded for this update (e.g. `recurrence`); it defaults to `update`. `detection`
 * is the HONEST provenance label folded into the audit detail (e.g. `auto:recurrence-consolidate`).
 * `detail` is extra structured provenance merged into the audit detail. None of this feeds scoring.
 */
export interface UpdateOpts {
  audit: AuditCtx;
  action?: string;
  detection?: LinkDetection;
  detail?: Record<string, unknown>;
}

/** Options for {@link MemoryStore.links}. `direction` defaults to `both`; `rels` filters by relation. */
export interface LinksOpts {
  rels?: Rel[];
  direction?: LinkDirectionFilter;
}

/** Statuses excluded from default recall (spec §4 step 3). */
export const HIDDEN_STATUSES: readonly MemoryStatus[] = [
  'forgotten',
  'deprecated',
  'contradicted',
];

/** A single piece of evidence attached to a claim (engine evidence shape, spec §2). */
export interface MemoryEvidence {
  kind: string;
  ref: string;
  shortId?: string;
  capturedAt?: string;
}

/** Who/what performed a mutation — recorded verbatim in the append-only audit trail (spec §7). */
export interface AuditCtx {
  actor: { kind: 'user' | 'agent' | 'system'; id?: string; name?: string };
  note?: string;
}

/**
 * Recall/listing query for the MemoryItem substrate. `repo` is REQUIRED and fails closed
 * (HOR-46) — a query without a repo identity must never see another repo's memory. The optional
 * tenancy fields widen, never weaken, that isolation.
 */
export interface MemoryQuery {
  repo: string;
  scope?: string;
  status?: MemoryStatus[];
  visibility?: Visibility;
  kind?: MemoryKind[];
  orgId?: string;
  workspaceId?: string;
  userId?: string;
  /** Cap on rows returned. */
  limit?: number;
}

/**
 * The legacy incident-recall record (map #4). `loadScoped` returns these; it is the
 * `incident_memory` row, kept distinct from the authored `MemoryItem` substrate.
 */
export type MemoryRecord = IncidentMemory;

// ---------------------------------------------------------------------------
// MemoryStore seam
// ---------------------------------------------------------------------------

/**
 * The durable system-of-record seam. Supersets the map #4 incident-recall seam additively: the
 * existing `recall`/`record`/`loadScoped` stay backed by `incident_memory`, while the new methods
 * back the authored `memory_item`/`memory_link`/`memory_audit` substrate. All writes are
 * best-effort at the call site (memory must never block report delivery — spec §7).
 */
export interface MemoryStore {
  // ---- existing incident-recall seam (map #4) — unchanged, backed by incident_memory ----
  recall(i: {
    tags: string[];
    project: string | null;
    excludeInvestigationId: string | null;
  }): Promise<SimilarIncident[]>;
  record(i: { investigationId: string | null; report: InvestigationReport }): Promise<void>;
  loadScoped(i: { project: string; tokens: string[] }): Promise<MemoryRecord[]>;

  // ---- MemoryItem substrate (new) — backed by memory_item/_link/_audit ----
  /** Insert an authored item (appends an `add` audit row). */
  add(item: NewMemoryItem, audit: AuditCtx): Promise<MemoryItem>;
  /**
   * Refresh an existing item's mutable authored fields ({@link MemoryUpdate}) IN PLACE and append an
   * audit row. Used by HOR-432 to CONSOLIDATE a recurring investigation into its existing memory
   * (bump count + refresh latest finding) rather than minting a duplicate. CONTEXT-ONLY: it never
   * touches `status` or the confidence/verdict scoring path. Returns the updated row.
   */
  update(id: string, patch: MemoryUpdate, opts: UpdateOpts): Promise<MemoryItem>;
  get(id: string): Promise<MemoryItem | null>;
  /** Scope/tenancy/status/visibility query. Fails closed on a missing repo (HOR-46). */
  query(q: MemoryQuery): Promise<MemoryItem[]>;
  /** confirm/forget/pin/mark-stale all route here; appends a status-transition audit row. */
  setStatus(id: string, status: MemoryStatus, audit: AuditCtx): Promise<void>;
  setVisibility(id: string, v: Visibility, audit: AuditCtx): Promise<void>;
  /** Refresh the staleness snapshot (lastVerifiedHash/At) and audit the verification. */
  verify(id: string, snap: { lastVerifiedHash: string | null }, audit: AuditCtx): Promise<void>;
  /**
   * Insert a typed link and append a `link` audit row (provenance for the edge). Returns the
   * persisted row (with its minted id) so mirrors can forward it. Memory→memory rels
   * (supersedes/contradicts/recurs-with) require `toKind:'memory'`, both endpoints to exist and
   * share a repo, and reject self-links; `recurs-with` is canonicalized + deduped (symmetric).
   */
  addLink(link: NewMemoryLink, opts?: AddLinkOpts): Promise<MemoryLink>;
  /**
   * Remove a memory→memory edge (the inverse of {@link addLink}) and append an `unlink` audit row to
   * the FROM item's trail. Only the FROZEN memory rels are addressable; `recurs-with` is canonicalized
   * so either orientation removes the one stored row. Returns the number of edges removed (0 when no
   * matching edge exists — a no-op, never an error). HONESTY: removing an edge drops the CONTEXT link
   * only; it NEVER mutates either item's status/confidence.
   */
  removeLink(spec: RemoveLinkSpec, opts?: RemoveLinkOpts): Promise<number>;
  /**
   * Traverse an item's edges, each annotated with its {@link LinkDirection}. `direction` defaults to
   * `both` (out = authored from the item; in = a `toKind:'memory'` edge pointing AT the item), so a
   * symmetric `recurs-with` edge always surfaces from either endpoint.
   */
  links(id: string, opts?: LinksOpts): Promise<AnnotatedMemoryLink[]>;
  /** The append-only audit trail for an item, most-recent-first. */
  history(id: string): Promise<MemoryAudit[]>;
}

// ---------------------------------------------------------------------------
// MemoryVectorIndex seam
// ---------------------------------------------------------------------------

/** A scored candidate proposed by the vector index. */
export interface VectorHit {
  memoryId: string;
  /** Similarity in 0..1. In M1 (Noop) this is Jaccard token overlap, NOT cosine. */
  score: number;
}

/**
 * The retrieval collaborator. In M2 this is backed by a different process (Python/nomic); in M1
 * the only implementation is the deterministic `NoopVectorIndex` (Jaccard/scope, no embeddings).
 * `search` is best-effort — callers must always be able to fall through to the store's lexical
 * query if the index is empty or unavailable.
 */
export interface MemoryVectorIndex {
  upsert(i: { memoryId: string; claim: string; repo: string; scope: string }): Promise<void>;
  search(i: { query: string; repo: string; limit: number }): Promise<VectorHit[]>;
  remove(memoryId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// NoopVectorIndex — the M1 vector index (Jaccard/scope only, NO embeddings)
// ---------------------------------------------------------------------------

interface NoopEntry {
  memoryId: string;
  repo: string;
  scope: string;
  tokens: string[];
}

/**
 * Tokenize free text into a deterministic, lowercase, de-duplicated token set: split on any
 * non-alphanumeric run, drop empties. Shared by upsert (claim) and search (query) so the two
 * sides are always compared in the same space.
 */
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw !== '' && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/**
 * Scope specificity rank — a deterministic tie-breaker so that, among equally-overlapping claims,
 * the narrowest (most-applicable) scope ranks first: symbol > module > repo > global.
 */
export function scopeSpecificity(scope: string): number {
  if (scope.startsWith('symbol:')) return 3;
  if (scope.startsWith('module:')) return 2;
  if (scope === 'repo') return 1;
  return 0; // global / unknown
}

/**
 * In-memory, embedding-free vector index. It stores upserted claims and answers `search` by
 * ranking stored claims (pre-filtered to the query's repo — HOR-46 fail-closed) by Jaccard token
 * overlap with the query, breaking ties by scope specificity then memoryId for full determinism.
 *
 * This is the ONLY `MemoryVectorIndex` in M1: there are no embeddings and no cross-process bridge.
 * It is purely a candidate proposer and is never consulted by the scoring path (honesty invariant).
 */
export class NoopVectorIndex implements MemoryVectorIndex {
  private readonly entries = new Map<string, NoopEntry>();

  async upsert(i: {
    memoryId: string;
    claim: string;
    repo: string;
    scope: string;
  }): Promise<void> {
    this.entries.set(i.memoryId, {
      memoryId: i.memoryId,
      repo: i.repo,
      scope: i.scope,
      tokens: tokenize(i.claim),
    });
  }

  async search(i: { query: string; repo: string; limit: number }): Promise<VectorHit[]> {
    const repo = i.repo.trim();
    if (repo === '') return []; // fail closed — no repo identity sees nothing (HOR-46)

    const queryTokens = tokenize(i.query);
    if (queryTokens.length === 0) return [];

    const scored = [...this.entries.values()]
      .filter((e) => e.repo === repo)
      .map((e) => ({
        memoryId: e.memoryId,
        score: tagOverlap(queryTokens, e.tokens),
        specificity: scopeSpecificity(e.scope),
      }))
      .filter((h) => h.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.specificity - a.specificity ||
          (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
      );

    const limit = Number.isFinite(i.limit) && i.limit > 0 ? Math.floor(i.limit) : scored.length;
    return scored.slice(0, limit).map((h) => ({ memoryId: h.memoryId, score: h.score }));
  }

  async remove(memoryId: string): Promise<void> {
    this.entries.delete(memoryId);
  }
}
