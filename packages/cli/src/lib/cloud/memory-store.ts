/**
 * Horus Memory M3 — the cloud-backed `MemoryStore` (the second factory behind the M1 seam).
 *
 * This is the cloud counterpart to `createLocalMemoryStore(db)`: it implements the SAME
 * `MemoryStore` interface (`@horus/engine`) but its bodies call the `/v1` API via `CloudClient`
 * instead of drizzle. It lives in the CLI's cloud layer — the engine NEVER imports cloud, so the
 * seam stays clean (mirrors investigation-sync).
 *
 * PRIVACY (non-negotiable, spec §5):
 *   - VECTORS NEVER LEAVE THE DEVICE. `toSyncInput` sends ONLY scalar/record fields; it never sends
 *     `payload` (where an embedding could hide) — see `toSyncInput`. The `MemoryVectorIndex` stays
 *     local-only in cloud mode; nothing here touches it.
 *   - `confirmed-outcome` is clamped to `visibility:'private'` before it leaves (the server clamps
 *     too — defense in depth). There is NO promotion path on the CLI side in M3.
 *
 * HONESTY (spec §6): this is a pure record store. `confidence`/`status`/`evidence` are opaque
 * authored attributes; nothing here computes or reads them into a scoring path.
 *
 * MINIMAL-CUT scope (spec critique): only `memory_items` is mirrored. Links, audit history, and the
 * legacy incident-recall seam (`recall`/`record`/`loadScoped`) are NOT cloud-backed — they return
 * empty / no-op here and stay local-only via the dual-write wrapper below.
 */

import type {
  MemoryStore,
  MemoryItem,
  NewMemoryItem,
  MemoryQuery,
  MemoryStatus,
  Visibility,
  AuditCtx,
  MemoryLink,
  MemoryAudit,
  MemoryEvidence,
} from "@horus/engine";
import { CloudClient, CloudError, type MemoryItemRecord, type MemoryItemSyncInput } from "./api.js";
import type { CloudConfig } from "./context-store.js";

/** Per-request cap so a runaway store never POSTs a multi-MB body (mirrors the cloud zod `.max`). */
const SYNC_BATCH_MAX = 500;
/** Default page size when scanning items back out of the cloud. */
const LIST_PAGE_LIMIT = 200;

/** confirmed-outcome can never be 'team' (spec §5.2) — clamp before anything leaves the device. */
function clampVisibility(
  kind: string | undefined | null,
  source: string | undefined | null,
  v: Visibility | undefined,
): Visibility {
  if (kind === "confirmed-outcome" || source === "confirmed-outcome") return "private";
  return v ?? "private";
}

/**
 * Map a CLI `NewMemoryItem` → the cloud sync wire shape. PRIVACY CHOKE POINT: this is an explicit
 * positive allowlist — `payload` is intentionally absent so no vector/embedding (which the CLI may
 * stash in `payload`) can ever be serialized over the wire.
 */
function toSyncInput(item: NewMemoryItem): MemoryItemSyncInput {
  const clientId = (item.id ?? "").trim();
  if (clientId === "") throw new Error("cloud memory sync requires a client item id");
  return {
    clientId,
    kind: item.kind,
    claim: item.claim,
    scope: item.scope,
    source: item.source,
    status: item.status ?? "fresh",
    confidence: item.confidence,
    visibility: clampVisibility(item.kind, item.source, item.visibility as Visibility | undefined),
    evidence: item.evidence as MemoryEvidence[] | undefined,
    lastVerifiedAt:
      item.lastVerifiedAt instanceof Date ? item.lastVerifiedAt.toISOString() : (item.lastVerifiedAt ?? null),
    lastVerifiedHash: item.lastVerifiedHash ?? null,
    clientCreatedAt:
      item.createdAt instanceof Date ? item.createdAt.toISOString() : (item.createdAt ?? null),
  };
}

/**
 * Map a cloud record → the `MemoryItem` row shape callers expect. `id` is ALWAYS the local ULID
 * (`clientId`) so callers stay unaware of cloud uuids. `repo` is stamped from context (the cloud
 * keys on `projectId`, not the local repo string). `payload` is never returned (it never left).
 */
function fromWire(r: MemoryItemRecord, repo: string): MemoryItem {
  return {
    id: r.clientId,
    kind: r.kind,
    claim: r.claim,
    scope: r.scope,
    source: r.source,
    evidence: (r.evidence as MemoryEvidence[] | undefined) ?? [],
    confidence: r.confidence,
    status: r.status,
    createdAt: new Date(r.clientCreatedAt ?? r.createdAt),
    lastVerifiedAt: r.lastVerifiedAt ? new Date(r.lastVerifiedAt) : null,
    lastVerifiedHash: r.lastVerifiedHash,
    orgId: r.organizationId ?? null,
    workspaceId: r.workspaceId ?? null,
    repo,
    userId: r.createdByUserId ?? null,
    visibility: r.visibility,
    payload: null,
  };
}

/**
 * The cloud-backed `MemoryStore`. `cfg.project.id` is required (HOR-46 fail-closed: a CLI with no
 * linked project cannot sync at all). Maps the M1 record's tenancy onto the cloud project/org via
 * `cloud.json` + the auth principal (server-resolved) — see the tenancy table in the spec §4.
 */
export function createCloudMemoryStore(client: CloudClient, cfg: CloudConfig): MemoryStore {
  const projectId = cfg.project?.id;
  if (!projectId) throw new Error("cloud memory store requires a linked cloud project");
  // The cloud keys on projectId; we stamp this back onto read rows for the local `repo` field.
  const repoFallback = cfg.project?.slug ?? "";

  const findInList = async (clientId: string): Promise<MemoryItem | null> => {
    let cursor: string | undefined;
    // Bounded scan: the minimal-cut list has no clientId filter, so page until found/exhausted.
    for (let page = 0; page < 50; page++) {
      const { items, nextCursor } = await client.listMemoryItems(projectId, {
        limit: LIST_PAGE_LIMIT,
        cursor,
      });
      const hit = items.find((it) => it.clientId === clientId);
      if (hit) return fromWire(hit, repoFallback);
      if (!nextCursor) return null;
      cursor = nextCursor;
    }
    return null;
  };

  const upsertOne = async (item: MemoryItemSyncInput): Promise<void> => {
    await client.syncMemoryItems(projectId, { items: [item] });
  };

  return {
    // ---- legacy incident-recall seam: NOT cloud-backed in M3 (stays local via dual-write) ----
    async recall() {
      return [];
    },
    async record() {
      /* no-op: incident memory is local-only in M3 */
    },
    async loadScoped() {
      return [];
    },

    // ---- authored MemoryItem substrate over /v1 ----
    async add(item: NewMemoryItem): Promise<MemoryItem> {
      const input = toSyncInput(item);
      const res = await client.syncMemoryItems(projectId, { items: [input] });
      const record = res.items.find((r) => r.clientId === input.clientId);
      if (record) return fromWire(record, item.repo ?? repoFallback);
      // The cloud accepted the upsert but did not echo the row — synthesize from local input so the
      // caller still gets a coherent MemoryItem (id is the local ULID, as always).
      return {
        id: input.clientId,
        kind: input.kind ?? item.kind,
        claim: input.claim ?? item.claim,
        scope: input.scope ?? item.scope,
        source: input.source ?? item.source,
        evidence: (item.evidence as MemoryEvidence[] | undefined) ?? [],
        confidence: item.confidence,
        status: input.status ?? "fresh",
        createdAt: item.createdAt instanceof Date ? item.createdAt : new Date(),
        lastVerifiedAt: item.lastVerifiedAt instanceof Date ? item.lastVerifiedAt : null,
        lastVerifiedHash: item.lastVerifiedHash ?? null,
        orgId: item.orgId ?? null,
        workspaceId: item.workspaceId ?? null,
        repo: item.repo ?? repoFallback,
        userId: item.userId ?? null,
        visibility: input.visibility ?? "private",
        payload: null,
      };
    },

    async get(id: string): Promise<MemoryItem | null> {
      try {
        return await findInList(id);
      } catch (e) {
        if (e instanceof CloudError && e.status === 404) return null;
        throw e;
      }
    },

    async query(q: MemoryQuery): Promise<MemoryItem[]> {
      const repo = q.repo.trim();
      if (repo === "") return []; // HOR-46 fail-closed — no repo identity sees nothing

      const { items } = await client.listMemoryItems(projectId, {
        status: q.status && q.status.length === 1 ? q.status[0] : undefined,
        kind: q.kind && q.kind.length === 1 ? q.kind[0] : undefined,
        limit: q.limit,
      });

      // Server already org + visibility filtered; apply the remaining client-side predicates so the
      // contract matches the local store regardless of which filters the cloud supports.
      const statusSet = q.status && q.status.length > 0 ? new Set<MemoryStatus>(q.status) : null;
      const kindSet = q.kind && q.kind.length > 0 ? new Set<string>(q.kind) : null;
      let rows = items
        .filter((r) => (q.scope === undefined ? true : r.scope === q.scope))
        .filter((r) => (q.visibility === undefined ? true : r.visibility === q.visibility))
        .filter((r) => (statusSet ? statusSet.has(r.status as MemoryStatus) : true))
        .filter((r) => (kindSet ? kindSet.has(r.kind) : true))
        .map((r) => fromWire(r, repo));

      if (q.limit !== undefined && q.limit > 0) rows = rows.slice(0, Math.floor(q.limit));
      return rows;
    },

    async setStatus(id: string, status: MemoryStatus): Promise<void> {
      await upsertOne({ clientId: id, status });
    },

    async setVisibility(id: string, v: Visibility): Promise<void> {
      // Passthrough; the server clamps confirmed-outcome. No promotion semantics on the CLI (spec §5).
      await upsertOne({ clientId: id, visibility: v });
    },

    async verify(id: string, snap: { lastVerifiedHash: string | null }): Promise<void> {
      await upsertOne({
        clientId: id,
        lastVerifiedHash: snap.lastVerifiedHash,
        lastVerifiedAt: new Date().toISOString(),
      });
    },

    // ---- links / audit: DEFERRED to M3.1 (no cloud reader exists) — local-only via dual-write ----
    async addLink(): Promise<void> {
      /* no-op in cloud: memory_links is not mirrored in the minimal M3 cut */
    },
    async links(): Promise<MemoryLink[]> {
      return [];
    },
    async history(): Promise<MemoryAudit[]> {
      return [];
    },
  };
}

/**
 * Compose a LOCAL (authoritative) store with a CLOUD (best-effort mirror) into one `MemoryStore`.
 *
 * Writes go to local FIRST (local Postgres stays source-of-truth), then to the cloud best-effort —
 * a cloud failure NEVER throws (memory must never block local work; spec §3c/§7). Reads always come
 * from local. The legacy recall seam + links/history stay local because the cloud store no-ops them.
 *
 * `onCloudError` lets the caller surface the failure (e.g. `reportCloudError`) without this layer
 * importing the command layer.
 */
export function dualWriteMemoryStore(
  local: MemoryStore,
  cloud: MemoryStore,
  onCloudError: (err: unknown) => void = () => {},
): MemoryStore {
  const mirror = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      onCloudError(err);
    }
  };

  return {
    // reads → local
    recall: (i) => local.recall(i),
    loadScoped: (i) => local.loadScoped(i),
    get: (id) => local.get(id),
    query: (q) => local.query(q),
    links: (id, opts) => local.links(id, opts),
    history: (id) => local.history(id),

    // writes → local first (authoritative), then best-effort cloud mirror
    async record(i) {
      await local.record(i);
      await mirror(() => cloud.record(i));
    },
    async add(item, audit) {
      const row = await local.add(item, audit);
      // Mirror with the persisted row's id so the cloud upserts on the same ULID.
      await mirror(() => cloud.add({ ...item, id: row.id }, audit));
      return row;
    },
    async setStatus(id, status, audit) {
      await local.setStatus(id, status, audit);
      await mirror(() => cloud.setStatus(id, status, audit));
    },
    async setVisibility(id, v, audit) {
      await local.setVisibility(id, v, audit);
      await mirror(() => cloud.setVisibility(id, v, audit));
    },
    async verify(id, snap, audit) {
      await local.verify(id, snap, audit);
      await mirror(() => cloud.verify(id, snap, audit));
    },
    async addLink(link) {
      await local.addLink(link);
      await mirror(() => cloud.addLink(link));
    },
  };
}
