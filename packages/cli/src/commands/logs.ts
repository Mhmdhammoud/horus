/**
 * `horus logs` — query structured logs as evidence from Elasticsearch (HOR-10).
 */

import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { logsProviderFromConfig } from '@horus/connectors';
import type { LogLevel } from '@horus/connectors';

/**
 * Parse a relative duration string (e.g. "24h", "7d", "30m") into an ISO
 * timestamp representing "now minus that duration". An ISO/date string is
 * passed through as-is. Returns undefined when `since` is undefined.
 */
function sinceToIso(since: string | undefined): string | undefined {
  if (since === undefined) return undefined;

  const match = /^(\d+)(m|h|d)$/.exec(since);
  if (match === null) {
    // Assume an ISO / date string — pass through.
    return since;
  }

  const amount = parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 'm';
  const msMap: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = (msMap[unit] ?? 60_000) * amount;
  return new Date(Date.now() - ms).toISOString();
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
    since?: string;
    level?: string;
    grep?: string;
    errors?: boolean;
    limit?: string;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const logs = logsProviderFromConfig(config);

    if (logs === null) {
      console.error(
        pc.red(
          'Elasticsearch not configured — set ES_URL / ES_USERNAME / ES_PASSWORD',
        ),
      );
      return 1;
    }

    const health = await logs.health();
    if (!health.ok) {
      console.error(pc.red(`Elasticsearch unreachable: ${health.detail}`));
      return 1;
    }

    const from = sinceToIso(opts.since);

    if (opts.errors === true) {
      const buckets = await logs.aggregateErrors({
        service,
        from,
        level: 'error',
      });

      console.log(pc.bold(`Error aggregation by event_code (service: ${service ?? '*'})`));
      console.log('');

      let total = 0;
      for (const b of buckets) {
        total += b.count;
        console.log(`  ${pc.red(String(b.count).padStart(6))}  ${b.key}`);
      }
      console.log('');
      console.log(`  Total: ${total} errors across ${buckets.length} code(s)`);
      return 0;
    }

    const records = await logs.searchLogs({
      service,
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
      const comp = r.component ?? r.service ?? '';
      const msg = r.message.slice(0, 120);
      const line = `${ts}  ${lvl}  ${comp.padEnd(30).slice(0, 30)}  ${msg}`;
      console.log(levelColor(r.level, line));
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
