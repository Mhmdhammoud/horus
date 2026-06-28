/**
 * HOR — the `horus memory` command group (spec §7, M1: user control + auditability).
 *
 * `memory show <scope>` is the read-only synthesis of deterministic incident memory + the
 * code-knowledge graph for a scope (see buildMemoryView in @horus/engine). M1 extends it to also
 * surface the PERSISTED authored memory items (memory_item) for the repo, clearly sectioned.
 *
 * The write/read leaves over the authored substrate — `add`/`confirm`/`forget`/`pin`/`list` — are
 * thin handlers over `createLocalMemoryStore` (the MemoryStore seam). Each follows the same
 * template: loadConfig → resolve the project (HOR-46 fail-closed: an unresolved project is a hard
 * ERROR, never a silent unscoped run) → openDb → store call → sql.end().
 *
 * HONESTY INVARIANT (spec §8): authored memory is CONTEXT ONLY. Nothing here is read by the
 * confidence/verdict scoring path. `confirm` may read an investigation report's confidence to LABEL
 * the stored item — never the reverse. The confirmed-outcome flywheel writes a PRIVATE, PII-gated
 * item and is never auto-promoted to team.
 */

import pc from 'picocolors';
import { createInterface } from 'node:readline/promises';
import type { HorusConfig } from '@horus/core';
import { loadConfig, resolveEnvironment, findRepoRoot } from '@horus/core';
import { createConnectors, memoryIndexForEnv } from '@horus/connectors';
import {
  openDb,
  getInvestigation,
  recordOutcomeLabel,
  listOutcomeLabels,
  summarizeOutcomeLabels,
  isOutcomeSource,
  type NewMemoryItem,
  type NewMemoryLink,
  type OutcomeLabel,
  type OutcomeSource,
} from '@horus/db';
import {
  buildMemoryView,
  renderMemoryView,
  memoryViewToJSON,
  createLocalMemoryStore,
  recallMemory,
  route,
  formatRouteStep,
  NoopVectorIndex,
  MemorySecretError,
  type MemoryStore,
  type MemoryVectorIndex,
  type RecalledMemory,
  type MemoryItem,
  type MemoryLink,
  type MemoryAudit,
  type MemoryKind,
  type MemoryStatus,
  type Visibility,
} from '@horus/engine';
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';
import { authedClient, repoRootOrCwd } from '../lib/cloud/session.js';
import {
  createCloudMemoryStore,
  dualWriteMemoryStore,
  toLinkSyncInput,
  toAuditSyncInput,
} from '../lib/cloud/memory-store.js';
import type { MemoryItemSyncInput } from '../lib/cloud/api.js';
import { reportCloudError } from './context.js';

// ---------------------------------------------------------------------------
// Shared constants + helpers
// ---------------------------------------------------------------------------

/** Authored-item kinds accepted by `memory add` (validated in TS, stored as text). */
const MEMORY_KINDS: readonly MemoryKind[] = [
  'code-fact',
  'contract',
  'decision',
  'pitfall',
  'incident-pattern',
  'confirmed-outcome',
];

/** Default confidence for a human-asserted claim (deterministic; user-overridable via --confidence). */
const DEFAULT_ADD_CONFIDENCE = 0.75;

/** Default confidence used to LABEL a confirmed-outcome when the report carries none. */
const DEFAULT_CONFIRM_CONFIDENCE = 0.8;

/** Every status — the `--all` allow-list for `memory list` (surfaces soft-forgotten rows too). */
const ALL_STATUSES: MemoryStatus[] = [
  'fresh',
  'possibly-stale',
  'contradicted',
  'deprecated',
  'pinned',
  'forgotten',
];

/**
 * Resolve the project/repo identity for a memory command. Memory is project-isolated (HOR-46):
 * an unresolved project is a hard ERROR (prints + returns null), never a silent unscoped run.
 */
function resolveProject(
  config: Awaited<ReturnType<typeof loadConfig>>,
  repo: string | undefined,
): string | null {
  let project: string | undefined;
  try {
    project = resolveEnvironment(config, { project: repo }).project;
  } catch {
    /* unresolvable — handled below */
  }
  if (!project) {
    console.error(
      pc.red('Could not resolve a project — pass --repo <name> or run inside a repo.'),
    );
    return null;
  }
  return project;
}

/**
 * Open the store + pool, run `fn`, and ALWAYS close the pool (mirror architecture.ts/show).
 *
 * When the repo is linked to Horus Cloud AND the user is logged in, the store becomes a DUAL-WRITE:
 * local Postgres stays source-of-truth (reads + authoritative writes) and the cloud is an additive,
 * best-effort mirror (a cloud failure warns, never blocks — spec §3c). Otherwise it is local-only.
 */
async function withStore<T>(url: string, fn: (store: MemoryStore) => Promise<T>): Promise<T> {
  const cfg = readCloudConfig(repoRootOrCwd());
  if (isCloudActive(cfg)) {
    const session = authedClient();
    if (session) {
      const { db, sql } = await openDb(url);
      try {
        const local = createLocalMemoryStore(db);
        const cloud = createCloudMemoryStore(session.client, cfg);
        return await fn(dualWriteMemoryStore(local, cloud, (err) => void reportCloudError(err)));
      } finally {
        await sql.end();
      }
    }
    console.error(
      pc.yellow('Linked to Horus Cloud but not logged in — memory stays local only. Run `horus login`.'),
    );
  }
  const { db, sql } = await openDb(url);
  try {
    return await fn(createLocalMemoryStore(db));
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Memory vector index (M2) — Source-when-available, Jaccard-Noop fallback
// ---------------------------------------------------------------------------

/**
 * Resolve the {@link MemoryVectorIndex} for a project (spec M2 / bridge §6-7). When the
 * project's repo has a `sourceHostUrl`, this is a `SourceMemoryVectorIndex` (nomic embeddings
 * on the single-RW host) composed OVER a local `NoopVectorIndex` so a down/absent host degrades
 * to deterministic Jaccard; otherwise it IS the `NoopVectorIndex`. Never throws — an unresolvable
 * env falls back to Noop so memory commands keep working with no source host configured.
 *
 * LOCAL-ONLY (HARD RULE): the source index talks only to the local host; memory vectors are a
 * rebuildable derived index and NEVER enter any cloud-sync path.
 */
function buildVectorIndex(config: HorusConfig, project: string): MemoryVectorIndex {
  const fallback = new NoopVectorIndex();
  try {
    const renv = resolveEnvironment(config, { project });
    // `memoryIndexForEnv` returns the structural twin of the engine seam; with a fallback
    // supplied it never returns null (the `?? fallback` is belt-and-braces).
    return (memoryIndexForEnv(renv, fallback) as MemoryVectorIndex | null) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Fire a BEST-EFFORT vector upsert. Memory add/confirm must NEVER block on or fail because of
 * vector indexing (spec M2): the durable Postgres record is already persisted by the time this
 * runs, and `SourceMemoryVectorIndex` already swallows host failures — this extra guard makes the
 * contract explicit and covers a misbehaving fallback. Emits nothing, so `--json` stays clean.
 */
async function bestEffortUpsert(
  index: MemoryVectorIndex,
  entry: { memoryId: string; claim: string; repo: string; scope: string },
): Promise<void> {
  try {
    await index.upsert(entry);
  } catch {
    // best-effort — a down host / index error never affects the command outcome
  }
}

/** Fire a BEST-EFFORT vector removal (mirror of {@link bestEffortUpsert} for soft-forget). */
async function bestEffortRemove(index: MemoryVectorIndex, memoryId: string): Promise<void> {
  try {
    await index.remove(memoryId);
  } catch {
    // best-effort — never affects the command outcome
  }
}

/** Parse an `--evidence` value ("kind:ref" or bare "ref") into the engine evidence shape. */
function parseEvidence(
  values: string[] | undefined,
  capturedAt: string,
): NewMemoryItem['evidence'] {
  if (values === undefined || values.length === 0) return [];
  return values
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map((v) => {
      const idx = v.indexOf(':');
      if (idx > 0) {
        return { kind: v.slice(0, idx).trim(), ref: v.slice(idx + 1).trim(), capturedAt };
      }
      return { kind: 'note', ref: v, capturedAt };
    });
}

/** Project a recalled item into a clean, machine-stable JSON object (no internal fields leak). */
function recalledToJSON(r: RecalledMemory): Record<string, unknown> {
  return {
    id: r.item.id,
    kind: r.item.kind,
    claim: r.item.claim,
    scope: r.item.scope,
    source: r.item.source,
    storedStatus: r.item.status,
    effectiveStatus: r.freshness.status,
    confidence: r.item.confidence,
    visibility: r.item.visibility,
    evidence: r.item.evidence,
    freshness: {
      label: r.freshness.label,
      ageDays: r.freshness.ageDays,
      verified: r.freshness.verified,
      driftDetected: r.freshness.driftDetected,
    },
    createdAt: r.item.createdAt,
    lastVerifiedAt: r.item.lastVerifiedAt,
  };
}

/** Render the persisted authored items as a Markdown section (under `memory show`/`list`). */
function renderStoredItems(items: RecalledMemory[]): string {
  const lines: string[] = [];
  lines.push('## Stored memory items');
  lines.push('');
  if (items.length === 0) {
    lines.push('_none on record_');
    return lines.join('\n');
  }
  for (const r of items) {
    const conf = `${(r.item.confidence * 100).toFixed(0)}%`;
    const drift = r.freshness.driftDetected ? ', drift-detected' : '';
    lines.push(`- [${r.item.id}] ${r.item.claim}`);
    lines.push(
      `  - ${r.item.kind} · scope: ${r.item.scope} · ${r.freshness.label}${drift} · confidence: ${conf}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// memory show <scope>
// ---------------------------------------------------------------------------

export async function runMemoryShow(
  scope: string,
  opts: {
    config?: string;
    repo?: string;
    json?: boolean;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const project = resolveProject(config, opts.repo);
    if (!project) return 1;

    const { code } = createConnectors(config);
    const repoPath = findRepoRoot(process.cwd()) ?? process.cwd();

    const { db, sql } = await openDb(config.database.url);
    try {
      const view = await buildMemoryView(scope, { code, db, repoPath, project });
      // Merge PERSISTED authored items (memory_item) for this repo — clearly sectioned.
      // Recall uses the Source-when-available vector index (M2); a down/absent host degrades
      // to the deterministic Jaccard NoopVectorIndex inside `recallMemory` (best-effort).
      const store = createLocalMemoryStore(db);
      const vectorIndex = buildVectorIndex(config, project);
      const stored = await recallMemory(
        store,
        { repo: project, text: scope },
        { limit: 50, vectorIndex },
      );

      // HOR-386 — nothing stored yet → the router points at `horus investigate <scope>`.
      const nextSteps = route({ command: 'memory', empty: stored.length === 0, query: scope });
      if (opts.json) {
        const parsed = JSON.parse(memoryViewToJSON(view)) as Record<string, unknown>;
        parsed.storedItems = stored.map(recalledToJSON);
        parsed.nextSteps = nextSteps;
        console.log(JSON.stringify(parsed, null, 2));
      } else {
        console.log(renderMemoryView(view));
        console.log('');
        console.log(renderStoredItems(stored));
        for (const s of nextSteps) console.log(pc.dim('  Suggested next: ') + formatRouteStep(s));
      }
      return 0;
    } finally {
      // Always close the pool (mirror architecture.ts).
      await sql.end();
    }
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// memory add <claim>
// ---------------------------------------------------------------------------

export async function runMemoryAdd(
  claim: string,
  opts: {
    config?: string;
    repo?: string;
    scope?: string;
    kind?: string;
    evidence?: string[];
    confidence?: string;
    json?: boolean;
  },
): Promise<number> {
  try {
    const text = (claim ?? '').trim();
    if (text === '') {
      console.error(pc.red('A non-empty claim is required.'));
      return 1;
    }

    const kind = (opts.kind ?? 'code-fact') as MemoryKind;
    if (!MEMORY_KINDS.includes(kind)) {
      console.error(pc.red(`Unknown --kind "${opts.kind}" (one of: ${MEMORY_KINDS.join(', ')}).`));
      return 1;
    }

    let confidence = DEFAULT_ADD_CONFIDENCE;
    if (opts.confidence !== undefined) {
      const c = Number(opts.confidence);
      if (!Number.isFinite(c) || c < 0 || c > 1) {
        console.error(pc.red('--confidence must be a number between 0 and 1.'));
        return 1;
      }
      confidence = c;
    }

    const config = await loadConfig(opts.config);
    const project = resolveProject(config, opts.repo);
    if (!project) return 1;

    const scope = (opts.scope ?? 'repo').trim() || 'repo';
    const evidence = parseEvidence(opts.evidence, new Date().toISOString());

    const item: NewMemoryItem = {
      id: '', // the store mints the real id
      kind,
      claim: text,
      scope,
      source: 'human',
      evidence,
      confidence,
      repo: project,
    };

    return await withStore(config.database.url, async (store) => {
      const created = await store.add(item, { actor: { kind: 'user' } });
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: true, id: created.id, kind: created.kind, scope: created.scope },
            null,
            2,
          ),
        );
      } else {
        console.log(
          pc.green(`Added memory item ${created.id} (${created.kind}, scope: ${created.scope}).`),
        );
      }
      // M2: best-effort vector upsert AFTER the durable record is persisted + surfaced. Never
      // blocks or fails the command — a down source host just leaves recall on Jaccard.
      await bestEffortUpsert(buildVectorIndex(config, project), {
        memoryId: created.id,
        claim: text,
        repo: project,
        scope,
      });
      return 0;
    });
  } catch (err) {
    if (err instanceof MemorySecretError) {
      console.error(pc.red(err.message));
      return 1;
    }
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// memory confirm <investigationId> — the confirmed-outcome flywheel (private, PII-gated)
// ---------------------------------------------------------------------------

export async function runMemoryConfirm(
  investigationId: string,
  opts: {
    config?: string;
    repo?: string;
    note?: string;
    json?: boolean;
  },
): Promise<number> {
  try {
    const id = (investigationId ?? '').trim();
    if (id === '') {
      console.error(pc.red('An investigation id is required.'));
      return 1;
    }

    const config = await loadConfig(opts.config);
    const project = resolveProject(config, opts.repo);
    if (!project) return 1;

    const { db, sql } = await openDb(config.database.url);
    try {
      const investigation = await getInvestigation(db, id);
      if (investigation === null) {
        console.error(pc.red(`Investigation not found: ${id}`));
        return 1;
      }

      // Build the flywheel label from the investigation's own outcome (NL claim, PII-gated on add).
      const report = (investigation.report ?? null) as {
        summary?: string;
        confidence?: number;
      } | null;
      const outcome =
        (report?.summary ?? '').trim() ||
        (investigation.summary ?? '').trim() ||
        investigation.title.trim();
      const claim = `Confirmed outcome for "${investigation.title}": ${outcome}`;
      const confidence =
        typeof report?.confidence === 'number' && Number.isFinite(report.confidence)
          ? report.confidence
          : DEFAULT_CONFIRM_CONFIDENCE;

      const store = createLocalMemoryStore(db);
      // confirmed-outcome stays PRIVATE — the store refuses to auto-promote it to team (spec §7).
      const item: NewMemoryItem = {
        id: '', // the store mints the real id
        kind: 'confirmed-outcome',
        claim,
        scope: 'repo',
        source: 'confirmed-outcome',
        evidence: [],
        confidence,
        repo: project,
        visibility: 'private',
      };
      const created = await store.add(item, {
        actor: { kind: 'user' },
        note: opts.note ?? `confirmed from investigation ${id}`,
      });
      // Link the confirmed-outcome item back to the source investigation (about-incident).
      const link: NewMemoryLink = {
        id: '', // the store mints the real id
        fromMemoryId: created.id,
        rel: 'about-incident',
        toKind: 'incident',
        toRef: id,
      };
      await store.addLink(link);

      // Converge into the eval store (HOR-390): confirming an investigation is the strongest
      // possible outcome signal — Horus pointed at the cause and a human verified it. Record it
      // as a durable label (resolved=yes + the confirmed cause) so it joins `horus feedback` in
      // the one queryable accuracy dataset. `project` is denormalized for accuracy-by-project.
      await recordOutcomeLabel(db, {
        investigationId: id,
        resolved: 'yes',
        source: 'confirm',
        confirmedCause: outcome,
        project,
        note: opts.note ?? null,
      });

      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: true, id: created.id, investigationId: id, visibility: created.visibility },
            null,
            2,
          ),
        );
      } else {
        console.log(
          pc.green(
            `Confirmed outcome stored as ${created.id} (private) and linked to investigation ${id}.`,
          ),
        );
      }
      // M2: best-effort vector upsert of the confirmed-outcome claim (private, repo-scoped).
      // The vector is LOCAL-ONLY — it never enters the cloud-sync path that handles `team` items.
      await bestEffortUpsert(buildVectorIndex(config, project), {
        memoryId: created.id,
        claim,
        repo: project,
        scope: 'repo',
      });
      return 0;
    } finally {
      await sql.end();
    }
  } catch (err) {
    if (err instanceof MemorySecretError) {
      console.error(pc.red(err.message));
      return 1;
    }
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// memory forget <id> (soft) / memory pin <id>
// ---------------------------------------------------------------------------

async function setStatusLeaf(
  id: string,
  status: MemoryStatus,
  verb: string,
  opts: { config?: string; note?: string; json?: boolean },
): Promise<number> {
  try {
    const memId = (id ?? '').trim();
    if (memId === '') {
      console.error(pc.red('A memory item id is required.'));
      return 1;
    }
    const config = await loadConfig(opts.config);
    return await withStore(config.database.url, async (store) => {
      await store.setStatus(memId, status, { actor: { kind: 'user' }, note: opts.note });
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, id: memId, status }, null, 2));
      } else {
        console.log(pc.green(`${verb} ${memId} (status: ${status}).`));
      }
      return 0;
    });
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

export async function runMemoryForget(
  id: string,
  opts: { config?: string; note?: string; json?: boolean },
): Promise<number> {
  // Soft delete — the row is retained, excluded from recall, and the transition is audited.
  const code = await setStatusLeaf(id, 'forgotten', 'Forgot', opts);
  if (code === 0) {
    // M2: best-effort drop of the DERIVED vector so a forgotten item stops surfacing in
    // semantic recall. The durable row is untouched; this only prunes the rebuildable index.
    // Resolve the project QUIETLY (no stderr noise) — skip removal if it cannot be resolved.
    try {
      const config = await loadConfig(opts.config);
      let project: string | undefined;
      try {
        project = resolveEnvironment(config, {}).project;
      } catch {
        project = undefined;
      }
      if (project) await bestEffortRemove(buildVectorIndex(config, project), id.trim());
    } catch {
      // best-effort — vector cleanup never affects the forget outcome
    }
  }
  return code;
}

export function runMemoryPin(
  id: string,
  opts: { config?: string; note?: string; json?: boolean },
): Promise<number> {
  return setStatusLeaf(id, 'pinned', 'Pinned', opts);
}

// ---------------------------------------------------------------------------
// memory list — persisted authored items for the repo
// ---------------------------------------------------------------------------

export async function runMemoryList(opts: {
  config?: string;
  repo?: string;
  all?: boolean;
  json?: boolean;
}): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const project = resolveProject(config, opts.repo);
    if (!project) return 1;

    return await withStore(config.database.url, async (store) => {
      // Default recall hides forgotten/deprecated/contradicted; --all surfaces every status.
      const status: MemoryStatus[] | undefined = opts.all ? ALL_STATUSES : undefined;
      const vectorIndex = buildVectorIndex(config, project);
      const items = await recallMemory(
        store,
        { repo: project, status },
        { limit: 200, vectorIndex },
      );

      if (opts.json) {
        console.log(JSON.stringify({ project, items: items.map(recalledToJSON) }, null, 2));
      } else {
        console.log(renderStoredItems(items));
      }
      return 0;
    });
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// memory sync — bulk backfill of LOCAL authored items into the linked cloud project
// ---------------------------------------------------------------------------

/** Per-request item cap so a backfill never POSTs a multi-MB body (mirrors the cloud zod `.max`). */
const MEMORY_SYNC_BATCH_MAX = 500;

/** Links/audit per-request cap (mirrors the cloud zod `.max(2000)` on each array). */
const MEMORY_SYNC_EDGE_BATCH_MAX = 2000;

/** Soft-deleted items are NOT backfilled (spec §3c: read all non-forgotten rows). */
const SYNCABLE_STATUSES: MemoryStatus[] = ALL_STATUSES.filter((s) => s !== 'forgotten');

/**
 * confirmed-outcome can never be 'team' (spec §5.2) — clamp before anything leaves the device.
 * The server clamps too; this is defense in depth on the CLI side.
 */
function clampVisibilityForSync(item: MemoryItem): Visibility {
  if (item.kind === 'confirmed-outcome' || item.source === 'confirmed-outcome') return 'private';
  return (item.visibility as Visibility | undefined) ?? 'private';
}

/**
 * Map a LOCAL `MemoryItem` row → the cloud sync wire shape. PRIVACY CHOKE POINT (spec §5): this is
 * an explicit positive allowlist. `payload` (where a vector/embedding could hide) is intentionally
 * NEVER serialized — vectors stay device-local and never cross the trust boundary.
 */
function toSyncInput(item: MemoryItem): MemoryItemSyncInput {
  return {
    clientId: item.id,
    kind: item.kind,
    claim: item.claim,
    scope: item.scope,
    source: item.source,
    status: item.status,
    confidence: item.confidence,
    visibility: clampVisibilityForSync(item),
    evidence: item.evidence,
    lastVerifiedAt: item.lastVerifiedAt ? item.lastVerifiedAt.toISOString() : null,
    lastVerifiedHash: item.lastVerifiedHash ?? null,
    clientCreatedAt: item.createdAt ? item.createdAt.toISOString() : null,
  };
}

/**
 * `horus memory sync` — push LOCAL authored memory items, their typed links, AND the append-only
 * audit trail to the linked cloud project, through the cloud `/v1` API (never the cloud DB). Mirrors
 * `horus cloud sync` (investigations): idempotent (the server upserts items on the CLI's stable ULID
 * `clientId`, dedupes links on their idempotencyKey, and treats audit as append-only on its
 * clientAuditId), best-effort, `--dry-run`/`--yes` gated, and the LOCAL store is NEVER mutated.
 *
 * Items are pushed FIRST so the server can resolve every link's `fromClientId` and every audit row's
 * `memoryClientId` to a persisted cloud item (against pre-existing rows), then links + audit follow.
 *
 * PRIVACY (non-negotiable, spec §5): the payload is a positive allowlist via {@link toSyncInput} (and
 * the link/audit mappers) — VECTORS NEVER LEAVE THE DEVICE, and confirmed-outcome items are clamped
 * to `private`.
 *
 * `--json` is clean: it emits a single JSON object, suppresses the preview/prompt, and proceeds
 * non-interactively (the operation is idempotent + local-safe). `--dry-run` is still honored.
 */
export async function runMemorySync(opts: {
  config?: string;
  cwd?: string;
  repo?: string;
  yes?: boolean;
  dryRun?: boolean;
  limit?: number;
  json?: boolean;
}): Promise<number> {
  const json = opts.json === true;
  const fail = (msg: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(pc.red(msg));
    return 1;
  };

  const root = repoRootOrCwd(opts.cwd);
  const cfg = readCloudConfig(root);
  if (!isCloudActive(cfg) || !cfg.project) {
    return fail("This repo isn't linked to a cloud project. Run `horus cloud link` first.");
  }
  const session = authedClient();
  if (!session) {
    return fail('Not logged in. Run `horus login` first.');
  }

  let config: HorusConfig;
  try {
    config = await loadConfig(opts.config);
  } catch (err) {
    return fail((err as Error).message);
  }

  // Resolve the LOCAL repo identity (HOR-46 fail-closed) used to scope the local query. The cloud
  // tenancy (org/workspace/project + owner) is resolved SERVER-SIDE from the path project + the
  // auth principal — the CLI never drives cloud scope from its local nullable tenancy columns.
  const project = resolveProject(config, opts.repo);
  if (!project) return 1;

  // Source: all non-forgotten local items for this repo, plus their links + audit. The local store
  // is the source of truth for all three and is read-only here.
  let items: MemoryItem[];
  let links: MemoryLink[];
  let auditRows: MemoryAudit[];
  const { db, sql } = await openDb(config.database.url);
  try {
    const store = createLocalMemoryStore(db);
    items = await store.query({
      repo: project,
      status: SYNCABLE_STATUSES,
      limit: opts.limit ?? 5000,
    });
    // Gather the links + audit for exactly these items (forgotten items are excluded above, so
    // their trail is not backfilled — spec §3c). Both are keyed by the same local ULIDs the cloud
    // resolves against, so re-running stays idempotent (links dedupe; audit is append-only).
    // Outgoing only: each edge is emitted once by its FROM item (a symmetric `recurs-with` is stored
    // canonically, so the owner side carries it) — `direction:'both'` would double-count the pair.
    const linkLists = await Promise.all(items.map((it) => store.links(it.id, { direction: "out" })));
    const auditLists = await Promise.all(items.map((it) => store.history(it.id)));
    links = linkLists.flat();
    auditRows = auditLists.flat();
  } finally {
    await sql.end();
  }

  const inputs = items.map(toSyncInput);
  const linkInputs = links.map(toLinkSyncInput);
  const auditInputs = auditRows.map(toAuditSyncInput);
  const target = `${cfg.organization?.slug}/${cfg.workspace?.slug}/${cfg.project.slug}`;

  if (inputs.length === 0) {
    if (json)
      console.log(
        JSON.stringify(
          { ok: true, target, synced: 0, failed: 0, total: 0, links: { synced: 0, total: 0 }, audit: { synced: 0, total: 0 } },
          null,
          2,
        ),
      );
    else console.log(pc.dim('No local memory items to sync.'));
    return 0;
  }

  // Preview (human mode only — keeps --json clean).
  if (!json) {
    console.log(
      pc.bold(
        `Will sync ${inputs.length} memory item(s), ${linkInputs.length} link(s), ` +
          `${auditInputs.length} audit row(s) to ${target} ${pc.dim('(cloud)')}:`,
      ),
    );
    for (const it of items.slice(0, 20)) {
      console.log(`  ${pc.dim(it.id.slice(0, 8))}  ${pc.dim(`[${it.kind}]`)} ${it.claim.slice(0, 70)}`);
    }
    if (items.length > 20) console.log(pc.dim(`  …and ${items.length - 20} more`));
  }

  if (opts.dryRun) {
    if (json)
      console.log(
        JSON.stringify(
          { ok: true, dryRun: true, target, total: inputs.length, links: linkInputs.length, audit: auditInputs.length },
          null,
          2,
        ),
      );
    else console.log(pc.dim('Dry run — nothing uploaded. Re-run without --dry-run to sync.'));
    return 0;
  }

  // Confirm unless --yes (human mode only). Non-interactive without --yes is a safe stop.
  if (!opts.yes && !json) {
    if (!process.stdin.isTTY) {
      console.error(
        pc.yellow(`Re-run with ${pc.bold('--yes')} to sync, or ${pc.bold('--dry-run')} to preview only.`),
      );
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`Sync ${inputs.length} memory item(s) to ${target}? (y/N) `))
        .trim()
        .toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        console.log(pc.dim('Aborted. Nothing synced.'));
        return 0;
      }
    } finally {
      rl.close();
    }
  }

  // Push in batches (best-effort): a failed batch is counted, never fatal. Re-running is safe — the
  // server upserts items on (organization_id, client_id), dedupes links on (organization_id,
  // idempotency_key), and appends audit on (organization_id, client_audit_id).
  let synced = 0;
  let syncedLinks = 0;
  let syncedAudit = 0;
  let failed = 0;

  // 1) Items FIRST — so links/audit can resolve their client ids against persisted cloud rows.
  for (let i = 0; i < inputs.length; i += MEMORY_SYNC_BATCH_MAX) {
    const batch = inputs.slice(i, i + MEMORY_SYNC_BATCH_MAX);
    try {
      const res = await session.client.syncMemoryItems(cfg.project.id, { items: batch });
      synced += res.items?.length ?? batch.length;
      if (!json) console.log(`${pc.green('✓')} synced ${batch.length} item(s)`);
    } catch (err) {
      failed += batch.length;
      if (json) reportCloudError(err);
      else console.error(`${pc.red('✗')} ${(err as Error).message}`);
    }
  }

  // 2) Links.
  for (let i = 0; i < linkInputs.length; i += MEMORY_SYNC_EDGE_BATCH_MAX) {
    const batch = linkInputs.slice(i, i + MEMORY_SYNC_EDGE_BATCH_MAX);
    try {
      const res = await session.client.syncMemoryItems(cfg.project.id, { links: batch });
      syncedLinks += res.links?.total ?? batch.length;
      if (!json) console.log(`${pc.green('✓')} synced ${batch.length} link(s)`);
    } catch (err) {
      failed += batch.length;
      if (json) reportCloudError(err);
      else console.error(`${pc.red('✗')} ${(err as Error).message}`);
    }
  }

  // 3) Audit (append-only).
  for (let i = 0; i < auditInputs.length; i += MEMORY_SYNC_EDGE_BATCH_MAX) {
    const batch = auditInputs.slice(i, i + MEMORY_SYNC_EDGE_BATCH_MAX);
    try {
      const res = await session.client.syncMemoryItems(cfg.project.id, { audit: batch });
      syncedAudit += res.audit?.total ?? batch.length;
      if (!json) console.log(`${pc.green('✓')} synced ${batch.length} audit row(s)`);
    } catch (err) {
      failed += batch.length;
      if (json) reportCloudError(err);
      else console.error(`${pc.red('✗')} ${(err as Error).message}`);
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: failed === 0,
          target,
          synced,
          failed,
          total: inputs.length,
          links: { synced: syncedLinks, total: linkInputs.length },
          audit: { synced: syncedAudit, total: auditInputs.length },
        },
        null,
        2,
      ),
    );
  } else {
    console.log('');
    console.log(
      `${pc.bold('Memory sync complete:')} ${pc.green(`${synced} item(s)`)}, ` +
        `${pc.green(`${syncedLinks} link(s)`)}, ${pc.green(`${syncedAudit} audit row(s)`)}, ` +
        (failed ? pc.red(`${failed} failed`) : '0 failed') + '.',
    );
    console.log(
      pc.dim('Local data was not modified. Re-running is safe — items/links dedupe by client id, audit is append-only. Vectors never sync.'),
    );
  }
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// memory accuracy — read the eval set (the flywheel's labeled outcome dataset)
// ---------------------------------------------------------------------------

/** Project an outcome-label row into a clean, machine-stable JSON object. */
function outcomeLabelToJSON(l: OutcomeLabel): Record<string, unknown> {
  return {
    id: l.id,
    investigationId: l.investigationId,
    resolved: l.resolved,
    source: l.source,
    confirmedCause: l.confirmedCause,
    note: l.note,
    project: l.project,
    at: l.at instanceof Date ? l.at.toISOString() : l.at,
  };
}

/**
 * `horus memory accuracy` — the read path over the converged eval store (HOR-390). Reports
 * Horus's own measured hit-rate ("did it point at the cause?") over the outcome labels written by
 * `horus memory confirm` (source=confirm) and `horus feedback` (source=feedback).
 *
 * HOR-46 (project isolation): scoped to the resolved project, fail-closed — an unresolved project
 * is a hard error, never a silent cross-project read. Optional `--source` and `--days` slice the
 * dataset. `--json` stays a single parseable document.
 */
export async function runMemoryAccuracy(opts: {
  config?: string;
  repo?: string;
  source?: string;
  days?: number;
  limit?: number;
  json?: boolean;
}): Promise<number> {
  try {
    let source: OutcomeSource | undefined;
    if (opts.source !== undefined) {
      if (!isOutcomeSource(opts.source)) {
        console.error(pc.red(`Unknown --source "${opts.source}" (one of: feedback, confirm).`));
        return 1;
      }
      source = opts.source;
    }

    let since: Date | undefined;
    if (opts.days !== undefined) {
      if (!Number.isFinite(opts.days) || opts.days <= 0) {
        console.error(pc.red('--days must be a positive number.'));
        return 1;
      }
      since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);
    }

    const config = await loadConfig(opts.config);
    const project = resolveProject(config, opts.repo);
    if (!project) return 1;

    const { db, sql } = await openDb(config.database.url);
    try {
      // HOR-46: every query is project-scoped. Newest-first; `summarize` is order-independent and
      // dedupes to the current verdict per investigation.
      const labels = await listOutcomeLabels(db, {
        project,
        source,
        since,
        limit: opts.limit,
      });
      const summary = summarizeOutcomeLabels(labels);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              project,
              source: source ?? null,
              since: since ? since.toISOString() : null,
              summary,
              labels: labels.map(outcomeLabelToJSON),
            },
            null,
            2,
          ),
        );
      } else {
        const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
        console.log(pc.bold(`Investigation accuracy — ${project}`));
        if (summary.evaluated === 0) {
          console.log(
            pc.dim(
              'No outcome labels yet. Confirm an investigation (`horus memory confirm <id>`) or ' +
                'leave feedback (`horus feedback <id> --resolved yes|partly|no`) to start the eval set.',
            ),
          );
        } else {
          console.log(
            `  Pointed at the cause: ${pc.green(pct(summary.accuracy))} ` +
              pc.dim(`(weighted ${pct(summary.weightedScore)}) over ${summary.evaluated} investigation(s)`),
          );
          console.log(
            `  Verdicts: ${pc.green(`${summary.counts.yes} yes`)}, ` +
              `${pc.yellow(`${summary.counts.partly} partly`)}, ${pc.red(`${summary.counts.no} no`)}`,
          );
          console.log(
            pc.dim(
              `  Source: ${summary.bySource.confirm} confirm, ${summary.bySource.feedback} feedback · ` +
                `${summary.attestations} total attestation(s)`,
            ),
          );
        }
      }
      return 0;
    } finally {
      await sql.end();
    }
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
