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
    errors?: boolean;
    limit?: string;
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
    const from = sinceToIso(opts.since);

    // --raw: the escape hatch for an actual line dump.
    if (opts.raw === true) {
      const records = await logs.searchLogs({
        service: resolvedService,
        from,
        level: opts.level as LogLevel | undefined,
        text: opts.grep,
        limit: opts.limit !== undefined ? Number(opts.limit) : 20,
      });
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
    const analysis = await logs.analyzeErrors({
      service: resolvedService,
      from,
      text: opts.grep,
    });

    console.log(
      pc.bold(`Error analysis`) +
        pc.dim(
          ` — ${renv.project}/${renv.env}` +
            (resolvedService ? ` · service ${resolvedService}` : '') +
            (opts.grep ? ` · grep "${opts.grep}"` : ''),
        ),
    );
    console.log(
      `  ${analysis.totalErrors} error(s) · ${analysis.signatures.length} signature(s) · ${pc.yellow(String(analysis.newSignatures.length))} new`,
    );
    console.log('');

    if (analysis.signatures.length === 0) {
      console.log(pc.dim('  No error-level logs in the window.'));
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
