/**
 * Shared investigation runner (HOR-CLI).
 *
 * The wiring that turns a resolved environment into a live engine call is substantial:
 * resolve every connector, self-heal a down source-intelligence host, degrade to
 * runtime-only when it stays down, open the local DB, call `investigate()` under a
 * deadline, and tear every handle back down so the process can exit.
 *
 * This lived inline in `runInvestigate`. Both `horus investigate` and `horus watch`
 * need it, so it is extracted here ONCE: `buildInvestigationContext()` constructs the
 * deps + DB and `runOneInvestigation()` runs a single investigation against them and
 * persists it (the engine writes the report into the local DB via the `db` dep, so it
 * lands in incident memory + `horus ask`). `disposeInvestigationContext()` closes
 * everything. Do NOT duplicate this flow — extend it.
 */

import pc from 'picocolors';
import type { ResolvedEnvironment } from '@horus/core';
import {
  codeForEnv,
  logsForEnv,
  mongoForEnv,
  postgresForEnv,
  sentryForEnv,
  queueForEnv,
  redisStateForEnv,
  metricsForEnv,
} from '@horus/connectors';
import type {
  LogsProvider,
  StateProvider,
  SentryProvider,
  QueueRuntimeProvider,
  RedisStateRuntimeProvider,
  MetricsProvider,
  CodeProvider,
} from '@horus/connectors';
import { openDb } from '@horus/db';
import type { DbHandle } from '@horus/db';
import { investigate } from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { ensureSourceHost, ensureHostReasonHint } from './ensure-host.js';

/**
 * Everything a single `investigate()` call needs: the resolved env, the live connectors,
 * the open DB handle, and whether the run is degraded to runtime-only (no source host).
 * Built once by `buildInvestigationContext`; reused for many investigations by a watcher.
 */
export interface InvestigationContext {
  renv: ResolvedEnvironment;
  dbHandle: DbHandle;
  /** True when the source-intelligence host was unreachable and could not be self-healed. */
  runtimeOnly: boolean;
  code: CodeProvider | null;
  logs: LogsProvider | null;
  mongo: StateProvider | null;
  postgres: StateProvider | null;
  sentry: SentryProvider | null;
  queue: QueueRuntimeProvider | null;
  redisState: RedisStateRuntimeProvider | null;
  metrics: MetricsProvider | null;
  /** Default service scope: CLI flag > ES connector's serviceName > undefined. */
  service?: string;
}

export interface BuildContextOptions {
  /** Database URL for the investigation store (config.database.url). */
  databaseUrl: string;
  /** Explicit service scope; falls back to the ES connector's configured serviceName. */
  service?: string;
  /** Sink for human-readable status/warning lines (default: console.error). */
  log?: (line: string) => void;
}

/**
 * Build a reusable investigation context for a resolved environment.
 *
 * Mirrors the connector wiring of `runInvestigate`: resolves a source `CodeProvider`,
 * attempts to self-heal a down host (then re-checks), and degrades to RUNTIME-ONLY when
 * the host stays down (HOR-319 layers 1 & 2). Resolves every runtime connector and opens
 * the local DB. Returns a context the caller reuses across one or many investigations.
 *
 * Throws when no source-intelligence connector is configured for the environment — the
 * same hard requirement `runInvestigate` enforces.
 */
export async function buildInvestigationContext(
  renv: ResolvedEnvironment,
  opts: BuildContextOptions,
): Promise<InvestigationContext> {
  const log = opts.log ?? ((l: string) => console.error(l));

  const code = codeForEnv(renv);
  if (!code) {
    throw new Error(
      `No source-intelligence connector configured for project "${renv.project}" / env "${renv.env}".`,
    );
  }

  const sourceUrl = renv.repositories[0]?.sourceHostUrl;
  let health = await code.health();
  if (!health.ok && sourceUrl) {
    // HOR-319 (layer-1): don't hard-exit just because the host is down. Try to restart a
    // previously-indexed host at its configured port, then re-check.
    log(pc.yellow(`Source-intelligence host unreachable (${sourceUrl}) — attempting to start it…`));
    const healed = await ensureSourceHost(renv.path, sourceUrl);
    if (healed.ok) {
      log(pc.green(`Source-intelligence host is up at ${healed.hostUrl}.`));
      health = await code.health();
    } else {
      log(pc.dim(`  ${ensureHostReasonHint(healed.reason)}`));
    }
  }

  // HOR-319 (layer-2): if self-heal failed, degrade to a runtime-only investigation —
  // logs/metrics/state/queues are independent of the source host.
  const runtimeOnly = !health.ok;
  if (runtimeOnly) {
    log(
      pc.yellow(
        `Proceeding in runtime-only mode — no source intelligence. ` +
          `Run ${pc.bold('horus index')} for a full (code-aware) investigation.`,
      ),
    );
  }

  const logs = logsForEnv(renv);
  const mongo = mongoForEnv(renv);
  const postgres = postgresForEnv(renv);
  const sentry = sentryForEnv(renv);
  const queue = queueForEnv(renv);
  const redisState = redisStateForEnv(renv);
  const metrics = metricsForEnv(renv);

  // Resolve service name: caller flag > connector default > undefined.
  const service = opts.service ?? renv.connectors.elasticsearch?.serviceName;

  const dbHandle = await openDb(databaseUrlOrThrow(opts.databaseUrl));

  return {
    renv,
    dbHandle,
    runtimeOnly,
    // Runtime-only degrade: pass no source provider so the engine skips seed
    // resolution + structural evidence and builds from runtime evidence.
    code: runtimeOnly ? null : code,
    logs,
    mongo,
    postgres,
    sentry,
    queue,
    redisState,
    metrics,
    ...(service !== undefined ? { service } : {}),
  };
}

function databaseUrlOrThrow(url: string): string {
  if (!url) throw new Error('No database URL configured for the investigation store.');
  return url;
}

/** Per-investigation overrides — the hint plus optional scoping/window flags. */
export interface RunInvestigationInput {
  hint: string;
  /** Git ref/range for change-impact (e.g. HEAD~5). */
  since?: string;
  /** Runtime-log window as a duration (e.g. 30d, 24h), independent of `since`. */
  logsSince?: string;
  /** Service scope override; defaults to the context's resolved service. */
  service?: string;
  /** Path scope for seed resolution (e.g. packages/core) — HOR-356. */
  scope?: string;
}

/**
 * Run a single investigation against a prepared context and persist it. The engine writes
 * the report into the local DB via the `db` dep, so it lands in incident memory and is
 * resolvable by `horus ask`. Bounded by `timeoutMs` so an unreachable/slow connector can
 * never hang the call forever.
 */
export async function runOneInvestigation(
  input: RunInvestigationInput,
  ctx: InvestigationContext,
  opts: { timeoutMs?: number } = {},
): Promise<InvestigationReport> {
  const { renv } = ctx;
  const investigation = investigate(
    {
      hint: input.hint,
      repo: renv.project,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.logsSince !== undefined ? { logsSince: input.logsSince } : {}),
      ...((input.service ?? ctx.service) !== undefined
        ? { service: input.service ?? ctx.service }
        : {}),
    },
    {
      code: ctx.code,
      db: ctx.dbHandle.db,
      logs: ctx.logs,
      mongo: ctx.mongo,
      postgres: ctx.postgres,
      sentry: ctx.sentry,
      queue: ctx.queue,
      redisState: ctx.redisState,
      metrics: ctx.metrics,
      repoPath: renv.path,
      connectors: {
        elasticsearch: !!renv.connectors.elasticsearch?.url,
        grafana: !!renv.connectors.grafana?.url,
        mongodb: !!renv.connectors.mongodb?.url,
        postgres: !!renv.connectors.postgres?.url,
        sentry: !!renv.connectors.sentry,
        redis: !!renv.connectors.redis?.url,
        queue: !!ctx.queue,
      },
    },
  );

  const timeoutMs =
    opts.timeoutMs ??
    (Number(process.env.HORUS_INVESTIGATE_TIMEOUT_S) || 120) * 1000;
  return withDeadline(investigation, timeoutMs);
}

/**
 * Close EVERY connector + the DB. An unclosed pg/ioredis handle keeps the Node event loop
 * alive, so the CLI prints its output but never exits. Idempotent-friendly: each close is
 * guarded and best-effort.
 */
export async function disposeInvestigationContext(ctx: InvestigationContext): Promise<void> {
  await safeClose(() => ctx.dbHandle.sql.end());
  if (ctx.mongo) await safeClose(() => ctx.mongo!.close());
  if (ctx.postgres) await safeClose(() => ctx.postgres!.close());
  if (ctx.redisState) await safeClose(() => ctx.redisState!.close());
  if (ctx.queue) await safeClose(() => ctx.queue!.close());
}

async function safeClose(fn: () => Promise<void> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort teardown — never throw past shutdown
  }
}

/**
 * Resolve `p`, or reject after `ms` with a clear, actionable message. The underlying work
 * is left to be torn down by process exit — this exists so a hung connector (e.g. a dropped
 * tunnel/port-forward, or a stuck source-intelligence query) can never hang the CLI forever.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Investigation exceeded ${Math.round(ms / 1000)}s and was aborted. A runtime connector ` +
            `is likely unreachable (e.g. a dropped SSH tunnel / port-forward) or the source-` +
            `intelligence host is slow. Re-run, or raise --timeout <seconds>.`,
        ),
      );
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
