/**
 * `horus metrics` — query Prometheus metrics as evidence (HOR-11).
 * Supports instant queries, range summaries, baseline comparison, and spike detection.
 */

import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { metricsProviderFromConfig } from '@horus/connectors';
import type { BaselineComparison, MetricSeries, SeriesSummary } from '@horus/connectors';
import { summarize } from '@horus/connectors';

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Parse a duration string (e.g. "1h", "30m", "2d", "90s") into seconds.
 * Defaults to 3600 (1h) for unrecognised strings.
 */
function sinceSecs(s: string | undefined): number {
  if (s === undefined) return 3600;
  const match = /^(\d+)(s|m|h|d)$/.exec(s);
  if (match === null) return 3600;
  const amount = parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 's';
  const table: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return (table[unit] ?? 1) * amount;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function labelStr(labels: Record<string, string>): string {
  const name = labels['__name__'];
  const parts: string[] = [];
  if (name !== undefined) parts.push(name);
  for (const key of ['job', 'instance', 'service']) {
    const val = labels[key];
    if (val !== undefined && val !== '') parts.push(`${key}="${val}"`);
  }
  if (parts.length === 0) {
    return Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(', ');
  }
  return parts.join(' ');
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(4);
}

function printSummary(s: SeriesSummary): void {
  const label = labelStr(s.labels);
  console.log(
    `  ${pc.cyan(label.padEnd(60).slice(0, 60))}` +
      `  last=${pc.bold(fmtNum(s.last))}` +
      `  avg=${fmtNum(s.avg)}` +
      `  min=${fmtNum(s.min)}` +
      `  max=${fmtNum(s.max)}`,
  );
}

function printComparison(c: BaselineComparison): void {
  const label = labelStr(c.labels);
  const ratioStr = Number.isFinite(c.ratio) ? c.ratio.toFixed(2) : 'inf';
  const spikeTag = c.isSpike ? pc.red(' [SPIKE]') : '';
  console.log(
    `  ${pc.cyan(label.padEnd(50).slice(0, 50))}` +
      `  ${fmtNum(c.baselineAvg)} -> ${pc.bold(fmtNum(c.currentAvg))}` +
      `  (x${ratioStr})${spikeTag}`,
  );
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runMetrics(
  query: string | undefined,
  opts: {
    config?: string;
    since?: string;
    step?: string;
    baseline?: boolean;
    spikes?: boolean;
  },
): Promise<number> {
  if (query === undefined || query.trim() === '') {
    console.error(
      pc.red(
        'Usage: horus metrics <promql> [--since 1h] [--baseline] [--spikes]',
      ),
    );
    return 1;
  }

  try {
    const config = await loadConfig(opts.config);
    const metrics = metricsProviderFromConfig(config);

    if (metrics === null) {
      console.error(
        pc.red(
          'Prometheus not configured — set PROM_URL, or GRAFANA_URL + GRAFANA_USER + GRAFANA_PASSWORD',
        ),
      );
      return 1;
    }

    const health = await metrics.health();
    if (!health.ok) {
      console.error(pc.red(`Prometheus unreachable: ${health.detail}`));
      return 1;
    }

    const step = opts.step !== undefined ? Number(opts.step) : 60;

    // --baseline: compare the --since window vs the preceding window
    if (opts.baseline === true) {
      const dur = sinceSecs(opts.since);
      const end = nowSecs();
      const curr = { from: end - dur, to: end };
      const base = { from: end - 2 * dur, to: end - dur };

      const cmps = await metrics.baseline(query, base, curr, step);

      console.log(pc.bold(`Baseline comparison for: ${query}`));
      console.log(pc.dim(`  baseline: ${new Date(base.from * 1000).toISOString()} – ${new Date(base.to * 1000).toISOString()}`));
      console.log(pc.dim(`  current:  ${new Date(curr.from * 1000).toISOString()} – ${new Date(curr.to * 1000).toISOString()}`));
      console.log('');

      if (cmps.length === 0) {
        console.log(pc.dim('  No series returned.'));
        return 0;
      }

      for (const c of cmps) {
        printComparison(c);
      }
      return 0;
    }

    // --spikes: detect z-score spikes within the --since window
    if (opts.spikes === true) {
      const dur = sinceSecs(opts.since);
      const end = nowSecs();
      const spikeSeries = await metrics.spikes(
        { query, from: end - dur, to: end, step },
      );

      console.log(pc.bold(`Spike detection for: ${query}`));
      console.log('');

      if (spikeSeries.length === 0) {
        console.log(pc.dim('  No spikes detected.'));
        return 0;
      }

      for (const s of spikeSeries) {
        const label = labelStr(s.labels);
        console.log(pc.cyan(`  ${label}`));
        for (const pt of s.points) {
          const ts = new Date(pt.t * 1000).toISOString();
          console.log(
            `    ${ts}  v=${pc.bold(fmtNum(pt.v))}  z=${pt.z.toFixed(2)}` +
              `  (mean=${fmtNum(pt.mean)}, std=${fmtNum(pt.std)})`,
          );
        }
      }
      return 0;
    }

    // --since: range query -> summarize per series
    if (opts.since !== undefined) {
      const dur = sinceSecs(opts.since);
      const end = nowSecs();
      const series: MetricSeries[] = await metrics.queryRange({
        query,
        from: end - dur,
        to: end,
        step,
      });

      console.log(pc.bold(`Range query for: ${query}`));
      console.log('');

      if (series.length === 0) {
        console.log(pc.dim('  No series returned.'));
        return 0;
      }

      for (const s of series) {
        printSummary(summarize(s));
      }
      return 0;
    }

    // Default: instant query
    const series = await metrics.queryInstant(query);

    console.log(pc.bold(`Instant query: ${query}`));
    console.log('');

    if (series.length === 0) {
      console.log(pc.dim('  No series returned.'));
      return 0;
    }

    for (const s of series) {
      const label = labelStr(s.labels);
      const sample = s.samples[0];
      const val = sample !== undefined ? fmtNum(sample.v) : 'N/A';
      console.log(`  ${pc.cyan(label.padEnd(60).slice(0, 60))}  = ${pc.bold(val)}`);
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
