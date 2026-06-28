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
import type { HorusConfig } from '@horus/core';
import { loadConfig, resolveEnvironment, findRepoRoot } from '@horus/core';
import { createConnectors, memoryIndexForEnv } from '@horus/connectors';
import {
  openDb,
  getInvestigation,
  type NewMemoryItem,
  type NewMemoryLink,
} from '@horus/db';
import {
  buildMemoryView,
  renderMemoryView,
  memoryViewToJSON,
  createLocalMemoryStore,
  recallMemory,
  NoopVectorIndex,
  MemorySecretError,
  type MemoryStore,
  type MemoryVectorIndex,
  type RecalledMemory,
  type MemoryKind,
  type MemoryStatus,
} from '@horus/engine';

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

/** Open the store + pool, run `fn`, and ALWAYS close the pool (mirror architecture.ts/show). */
async function withStore<T>(url: string, fn: (store: MemoryStore) => Promise<T>): Promise<T> {
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

      if (opts.json) {
        const parsed = JSON.parse(memoryViewToJSON(view)) as Record<string, unknown>;
        parsed.storedItems = stored.map(recalledToJSON);
        console.log(JSON.stringify(parsed, null, 2));
      } else {
        console.log(renderMemoryView(view));
        console.log('');
        console.log(renderStoredItems(stored));
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
