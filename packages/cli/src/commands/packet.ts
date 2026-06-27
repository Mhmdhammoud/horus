/**
 * HOR-384 — `horus packet`: a compact, honesty-framed projection of an investigation
 * for an agent's context window.
 *
 * Two input modes, auto-detected:
 *   - saved investigation id (UUID) → load the persisted report (no re-query) and project it.
 *   - hint → run a fresh investigation, then project it. There is no hint-keyed reuse/TTL cache
 *     in the codebase today, so the honest implementation is a fresh run (follow-up: HOR — add
 *     hint-keyed recent-investigation reuse / TTL cache).
 *
 * Output: `--json` emits `packetToJSON` (clean for piping into agents); otherwise the Markdown
 * rendering. `--for <agent>` is a thin presentation preset that only tightens caps / drops
 * timestamps — it never changes which evidence or caveats are computed.
 */

import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { openDb, getInvestigation } from '@horus/db';
import {
  buildPacket,
  renderPacketMarkdown,
  packetToJSON,
  migrateReport,
} from '@horus/engine';
import type { InvestigationReport, AgentPreset, PacketFreshness } from '@horus/engine';
import { resolveDbUrl } from '../lib/db-url.js';
import { repoRootOrCwd } from '../lib/cloud/session.js';
import {
  computeFreshness,
  readIndexMeta,
  commitsSince,
  semanticSearchReady,
} from '../lib/freshness.js';
import {
  buildInvestigationContext,
  runOneInvestigation,
  disposeInvestigationContext,
} from '../lib/investigation-runner.js';

/** Standard UUID (the id `engine.investigate()` mints via crypto.randomUUID). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valid `--for` presets; anything else is rejected with a clear message. */
const PRESETS: ReadonlySet<AgentPreset> = new Set(['claude', 'cursor', 'generic']);

/**
 * Compute the freshness inputs the honesty header consumes, from the repo's index metadata
 * + the report's evidence timestamps, plus the semantic-search-readiness flag (which is NOT
 * part of `computeFreshness().caveats` and must be passed explicitly — see freshness.ts).
 */
async function computePacketFreshness(
  repoRoot: string,
  report: InvestigationReport,
): Promise<PacketFreshness> {
  const meta = readIndexMeta(repoRoot);
  const commitsSinceIndex = meta?.lastIndexedAt
    ? await commitsSince(repoRoot, meta.lastIndexedAt)
    : null;
  const f = computeFreshness({
    repoRoot,
    evidence: report.evidence,
    nowIso: new Date().toISOString(),
    meta,
    commitsSinceIndex,
  });
  return {
    indexStale: f.indexStale,
    commitsSinceIndex: f.commitsSinceIndex,
    runtimeWindow: f.runtimeWindow,
    caveats: f.caveats,
    semanticSearchReady: semanticSearchReady(meta),
  };
}

/** Emit the packet in the requested format. */
function emitPacket(
  report: InvestigationReport,
  opts: { json?: boolean; for_?: AgentPreset; freshness?: PacketFreshness },
): void {
  const packet = buildPacket(report, {
    ...(opts.for_ !== undefined ? { preset: opts.for_ } : {}),
    ...(opts.freshness !== undefined ? { freshness: opts.freshness } : {}),
  });
  if (opts.json) {
    console.log(JSON.stringify(packetToJSON(packet), null, 2));
  } else {
    console.log(renderPacketMarkdown(packet));
  }
}

export async function runPacket(
  hintOrId: string,
  opts: {
    config?: string;
    name?: string;
    project?: string;
    env?: string;
    scope?: string;
    service?: string;
    since?: string;
    timeout?: string;
    for?: string;
    json?: boolean;
  },
): Promise<number> {
  // `--for` is presentation-only; validate up front so an agent gets a clear error, not silence.
  let preset: AgentPreset | undefined;
  if (opts.for !== undefined) {
    if (!PRESETS.has(opts.for as AgentPreset)) {
      console.error(
        pc.red(
          `Unknown --for preset "${opts.for}". Expected one of: ${[...PRESETS].join(', ')}.`,
        ),
      );
      return 1;
    }
    preset = opts.for as AgentPreset;
  }

  // ── Saved-id path: load the persisted report, no re-query ───────────────────
  if (UUID_RE.test(hintOrId)) {
    const { db, sql } = await openDb(await resolveDbUrl(opts.config));
    try {
      const row = await getInvestigation(db, hintOrId);
      if (!row) {
        console.error(pc.red('No investigation found: ' + hintOrId));
        return 1;
      }
      if (!row.report) {
        console.error(
          pc.red(
            'Investigation ' + hintOrId + ' has no stored report (run a newer investigation).',
          ),
        );
        return 1;
      }
      const report = migrateReport(row.report) as InvestigationReport;
      const freshness = await computePacketFreshness(repoRootOrCwd(), report);
      emitPacket(report, { json: opts.json, for_: preset, freshness });
      return 0;
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      console.error(pc.red(msg.trim() ? msg : 'Failed to load investigation.'));
      if (process.env.HORUS_DEBUG) console.error(pc.dim((err as Error)?.stack ?? String(err)));
      return 1;
    } finally {
      await sql.end();
    }
  }

  // ── Hint path: run a fresh investigation, then project it ────────────────────
  try {
    const config = await loadConfig(opts.config, { name: opts.name });
    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.project, env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const repoRoot = repoRootOrCwd(renv.path);

    let ctx;
    try {
      ctx = await buildInvestigationContext(renv, {
        databaseUrl: config.database.url,
        ...(opts.service !== undefined ? { service: opts.service } : {}),
      });
    } catch (err) {
      // No source-intelligence connector configured — same hard requirement as `investigate`.
      console.error(pc.red((err as Error).message));
      return 1;
    }

    try {
      const timeoutSec =
        (opts.timeout !== undefined ? Number(opts.timeout) : 0) ||
        Number(process.env.HORUS_INVESTIGATE_TIMEOUT_S) ||
        120;
      const report = await runOneInvestigation(
        {
          hint: hintOrId,
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
          ...(opts.since !== undefined ? { since: opts.since } : {}),
          ...(opts.service !== undefined ? { service: opts.service } : {}),
        },
        ctx,
        { timeoutMs: timeoutSec * 1000 },
      );
      const freshness = await computePacketFreshness(repoRoot, report);
      emitPacket(report, { json: opts.json, for_: preset, freshness });
    } finally {
      // Close EVERY connector + the DB or the process lingers forever (unclosed pg/ioredis handle).
      await disposeInvestigationContext(ctx);
    }
    return 0;
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    console.error(pc.red(msg.trim() ? msg : 'Packet generation failed (unknown error).'));
    if (process.env.HORUS_DEBUG) console.error(pc.dim((err as Error)?.stack ?? String(err)));
    return 1;
  }
}
