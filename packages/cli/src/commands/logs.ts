/**
 * `horus logs` — turn logs into EVIDENCE (HOR-10). The default view synthesizes
 * error signatures (count, first/last occurrence, affected services, NEW/spike);
 * `--raw` falls back to a plain line dump for humans who want the raw lines.
 *
 * Project/environment-scoped (HOR-34): resolves the Elasticsearch connector for
 * the chosen project/env — there is no global Elasticsearch default.
 */

import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { logsForEnv, shortTs } from '@horus/connectors';
import type { LogLevel } from '@horus/connectors';

/** Parse "24h" / "7d" / "30m" into an ISO "now minus that"; pass ISO through. */
function sinceToIso(since: string | undefined): string | undefined {
  if (since === undefined) return undefined;
  const match = /^(\d+)(m|h|d)$/.exec(since);
  if (match === null) return since;
  const amount = parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 'm';
  const msMap: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() - (msMap[unit] ?? 60_000) * amount).toISOString();
}

/**
 * Resolve the severity floor for `--raw` (HOR-209). Defaults to `error` so raw lines
 * match the summary's error+ view; an explicit `--level` overrides; `--all-levels`
 * removes the floor entirely (returns undefined = all levels).
 */
export function resolveRawLevel(opts: { level?: string; allLevels?: boolean }): LogLevel | undefined {
  if (opts.allLevels) return undefined;
  return (opts.level as LogLevel | undefined) ?? 'error';
}

function levelColor(level: string, text: string): string {
  if (level === 'error' || level === 'fatal') return pc.red(text);
  if (level === 'warn') return pc.yellow(text);
  return pc.dim(text);
}

export async function runLogs(
  service: string | undefined,
  opts: {
    config?: string;
    name?: string;
    project?: string;
    env?: string;
    since?: string;
    level?: string;
    grep?: string;
    raw?: boolean;
    /** Show all severity levels in --raw (default is error+ to match the summary). */
    allLevels?: boolean;
    errors?: boolean;
    limit?: string;
    json?: boolean;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config, { name: opts.name });

    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.project, env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const logs = logsForEnv(renv);
    if (logs === null) {
      console.error(
        pc.red(
          `No Elasticsearch connector configured for ${renv.project}/${renv.env} ` +
            `(set ES_URL / ES_USERNAME / ES_PASSWORD)`,
        ),
      );
      return 1;
    }

    const health = await logs.health();
    if (!health.ok) {
      console.error(pc.red(`Elasticsearch unreachable: ${health.detail}`));
      return 1;
    }

    const resolvedService = service ?? renv.connectors.elasticsearch?.serviceName;
    const indexPattern = renv.connectors.elasticsearch?.indexPattern ?? '*';

    // Validate that the configured field mapping is compatible with the actual
    // index before querying. Errors block collection; warnings are advisory.
    // Pass requiresService so a missing service field blocks rather than silently
    // returning zero results.
    try {
      const compat = await logs.checkCompatibility({
        requiresService: resolvedService !== undefined,
        // raw mode dumps log lines (searchLogs); only the default path calls
        // analyzeErrors() which requires aggregatable event-code and service fields.
        requiresServiceAggregation: opts.raw !== true,
        requiresEventCode: opts.raw !== true,
      });
      for (const w of compat.issues.filter((i) => i.severity === 'warning')) {
        console.warn(pc.yellow(`[warn] ${w.field}: ${w.message}`));
      }
      const errors = compat.issues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        console.error(pc.red('Elasticsearch field mapping is incompatible with the index:'));
        for (const e of errors) {
          console.error(pc.red(`  ${e.field}: ${e.message}`));
        }
        console.error(
          pc.dim('Fix fields.* overrides in your connector config or choose the correct preset.'),
        );
        return 1;
      }
    } catch {
      // Compat check is best-effort: network or auth errors must not prevent
      // legitimate queries from proceeding.
      console.warn(pc.dim('[warn] Elasticsearch compatibility check unavailable — proceeding.'));
    }

    // Default to 7 days to match the investigation engine's default window
    // (investigation uses logWindowFrom(undefined) = 7d; former implicit default was 24h).
    const from = sinceToIso(opts.since) ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    const fromDisplay = from.slice(0, 16).replace('T', ' ');

    // --raw: the escape hatch for an actual line dump. By default it preserves the
    // summary's error+ severity filter so `--raw` surfaces the same errors the summary
    // counts (HOR-209) — previously it dumped recent INFO/DEBUG. An explicit --level
    // overrides; --all-levels removes the severity floor entirely.
    if (opts.raw === true) {
      const rawLevel = resolveRawLevel(opts);
      const limit = opts.limit !== undefined ? Math.min(Number(opts.limit), 1000) : 20;
      const records = await logs.searchLogs({
        service: resolvedService,
        from,
        level: rawLevel,
        text: opts.grep,
        limit,
      });
      if (opts.json) {
        // Curated record shape — omit the raw ES doc (may be large / contain anything).
        console.log(
          JSON.stringify(
            {
              scope: {
                project: renv.project,
                env: renv.env,
                service: resolvedService ?? null,
                index: indexPattern,
                from,
                level: rawLevel ?? 'all',
                grep: opts.grep ?? null,
              },
              records: records.map((r) => ({
                timestamp: r.timestamp,
                level: r.level,
                service: r.service ?? null,
                component: r.component ?? null,
                eventCode: r.eventCode ?? null,
                message: r.message,
                traceId: r.traceId ?? null,
                requestId: r.requestId ?? null,
              })),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      if (records.length === 0) {
        console.log(pc.dim('No logs matched.'));
        return 0;
      }
      for (const r of records) {
        const ts = r.timestamp ? r.timestamp.slice(0, 23) : '                       ';
        const lvl = `[${r.level.toUpperCase().padEnd(5)}]`;
        const comp = (r.component ?? r.service ?? '').padEnd(30).slice(0, 30);
        const line = `${ts}  ${lvl}  ${comp}  ${r.message.slice(0, 120)}`;
        console.log(levelColor(r.level, line));
      }
      return 0;
    }

    // Default: synthesize error evidence.
    let analysis = await logs.analyzeErrors({
      service: resolvedService,
      from,
      text: opts.grep,
    });

    let scopeService = resolvedService;
    let broadeningNote: string | undefined;

    // Broader discovery mode: when a service filter returns 0 signatures, retry
    // without the filter so the user sees the actual log volume in this environment.
    // This prevents `horus logs "sale"` from silently implying there are no errors
    // when investigation can find thousands (HOR-157).
    if (analysis.signatures.length === 0 && resolvedService !== undefined) {
      const broader = await logs.analyzeErrors({ from, text: opts.grep });
      if (broader.signatures.length > 0) {
        analysis = broader;
        broadeningNote = `No errors found for service "${resolvedService}" — showing all services`;
        scopeService = undefined;
      }
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            scope: {
              project: renv.project,
              env: renv.env,
              service: scopeService ?? null,
              index: indexPattern,
              from,
              severity: 'error+',
              grep: opts.grep ?? null,
            },
            totalErrors: analysis.totalErrors,
            signatures: analysis.signatures,
            newSignatures: analysis.newSignatures,
            affectedServices: analysis.affectedServices,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    console.log(
      pc.bold(`Error analysis`) +
        pc.dim(
          ` — ${renv.project}/${renv.env}` +
            (scopeService ? ` · service ${scopeService}` : '') +
            (opts.grep ? ` · grep "${opts.grep}"` : ''),
        ),
    );
    console.log(pc.dim(`  index: ${indexPattern} · from: ${fromDisplay} UTC · severity: error+`));
    if (broadeningNote) {
      console.log(pc.yellow(`  ${broadeningNote}`));
    }
    console.log(
      `  ${analysis.totalErrors} error(s) · ${analysis.signatures.length} signature(s) · ${pc.yellow(String(analysis.newSignatures.length))} new`,
    );
    console.log('');

    if (analysis.signatures.length === 0) {
      console.log(pc.dim('  No error-level logs in the window.'));
      console.log(
        pc.dim(
          `  Searched: ${scopeService ? `service "${scopeService}"` : 'all services'} · index: ${indexPattern} · from: ${fromDisplay} UTC`,
        ),
      );
      console.log(pc.dim(`  Tip: use --since to widen the window (e.g. --since 30d).`));
      return 0;
    }

    for (const s of analysis.signatures) {
      const tags: string[] = [];
      if (s.isNew) tags.push(pc.red('NEW'));
      else if (s.ratio !== undefined && Number.isFinite(s.ratio) && s.ratio >= 1.5) {
        tags.push(pc.yellow(`spike x${s.ratio.toFixed(1)}`));
      }
      const svc = s.services.length > 0 ? pc.dim(` · ${s.services.slice(0, 3).join(', ')}`) : '';
      const tagStr = tags.length > 0 ? `  [${tags.join(', ')}]` : '';
      console.log(
        `  ${pc.red(String(s.count).padStart(6))}  ${pc.bold(s.key.padEnd(14).slice(0, 14))}  ` +
          pc.dim(`first ${shortTs(s.firstSeen)} · last ${shortTs(s.lastSeen)}`) +
          svc +
          tagStr,
      );
    }

    if (analysis.affectedServices.length > 0) {
      console.log('');
      console.log(`  ${pc.bold('Affected services:')} ${analysis.affectedServices.join(', ')}`);
    }
    console.log('');
    console.log(pc.dim('  (use --raw to see individual log lines)'));
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
