/**
 * Grafana metrics provider for @horus/connectors (HOR-11 reframe).
 * Entry point: Grafana. Prometheus queries execute through the Grafana datasource proxy.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import type { Provider } from '../contract.js';
import { GrafanaClient } from './client.js';
import { parseRange } from './series.js';
import type { MetricSeries } from './series.js';
import {
  extractPanels,
  sanitizeExpr,
  panelMatchesHint,
} from './panels.js';
import type { Panel } from './panels.js';
import { buildFindings, findingsToEvidence } from './analyze.js';
import type { MetricFinding } from './analyze.js';

// ---------------------------------------------------------------------------
// MetricsProvider interface (replaces old Prometheus-based shape)
// ---------------------------------------------------------------------------

export interface MetricsProvider extends Provider {
  findPanels(hint?: string, signal?: AbortSignal): Promise<Panel[]>;
  analyze(opts: { hint?: string; from: number; to: number; step?: number; signal?: AbortSignal }): Promise<MetricFinding[]>;
  rawRange(expr: string, from: number, to: number, step?: number): Promise<MetricSeries[]>;
  toEvidence(findings: MetricFinding[]): Evidence[];
  health(): Promise<HealthStatus>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GrafanaMetricsProvider implements MetricsProvider {
  readonly id = 'grafana';
  readonly kind: ProviderKind = 'metrics';

  constructor(
    private readonly client: GrafanaClient,
    private readonly opts: { defaultStep: number },
  ) {}

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }

  /**
   * Search all dashboards and return the leaf panels.
   * The `hint` filters PANELS (by title/expr), not the dashboard search: Grafana's
   * search `query` matches dashboard titles, so forwarding a panel-level hint
   * (e.g. "latency", "queue") would wrongly exclude the dashboard that holds them.
   * Each panel is tagged with the dashboardUid it came from.
   */
  async findPanels(hint?: string, signal?: AbortSignal): Promise<Panel[]> {
    const dashboards = await this.client.searchDashboards(undefined, signal);
    const allPanels: Panel[] = [];

    for (const dash of dashboards) {
      signal?.throwIfAborted();
      let dashboardObj: unknown;
      try {
        dashboardObj = await this.client.getDashboard(dash.uid, signal);
      } catch (err) {
        // Abort must propagate — only skip genuinely failed dashboard fetches.
        if (signal?.aborted) throw signal.reason ?? err;
        continue;
      }
      const panels = extractPanels(dashboardObj);
      for (const panel of panels) {
        panel.dashboardUid = dash.uid;
        if (hint !== undefined && !panelMatchesHint(panel, hint)) continue;
        allPanels.push(panel);
      }
    }

    return allPanels;
  }

  /**
   * Discover relevant panels, query current + baseline windows for each expr,
   * and return MetricFindings (including "none" anomalies for completeness).
   */
  async analyze(opts: {
    hint?: string;
    from: number;
    to: number;
    step?: number;
    signal?: AbortSignal;
  }): Promise<MetricFinding[]> {
    const { signal } = opts;
    const step = opts.step ?? this.opts.defaultStep;
    const windowSecs = opts.to - opts.from;
    const panels = await this.findPanels(opts.hint, signal);
    const allFindings: MetricFinding[] = [];

    for (const panel of panels) {
      signal?.throwIfAborted();
      for (const rawExpr of panel.exprs) {
        signal?.throwIfAborted();
        const expr = sanitizeExpr(rawExpr);
        if (expr === null) continue;

        try {
          const [currentResp, baselineResp] = await Promise.all([
            this.client.datasourceRange(panel.datasourceUid, expr, opts.from, opts.to, step, signal),
            this.client.datasourceRange(
              panel.datasourceUid,
              expr,
              opts.from - windowSecs,
              opts.from,
              step,
              signal,
            ),
          ]);
          const current = parseRange(currentResp);
          const baseline = parseRange(baselineResp);
          const findings = buildFindings(
            panel.dashboardUid ?? '',
            panel.title,
            panel.kind,
            baseline,
            current,
          );
          allFindings.push(...findings);
        } catch (err) {
          // Abort must propagate — only skip genuinely bad individual queries.
          if (signal?.aborted) throw signal.reason ?? err;
          continue;
        }
      }
    }

    return allFindings;
  }

  /**
   * Raw escape hatch: execute a single PromQL expression against the default
   * Prometheus datasource (uid "Prometheus") or the first panel datasource found.
   */
  async rawRange(
    expr: string,
    from: number,
    to: number,
    step?: number,
  ): Promise<MetricSeries[]> {
    // Attempt to find a datasource uid from panels; fall back to "Prometheus"
    let dsUid = 'Prometheus';
    try {
      const panels = await this.findPanels();
      const firstWithDs = panels.find(
        (p) => p.datasourceUid !== '' && p.datasourceUid !== undefined,
      );
      if (firstWithDs !== undefined) {
        dsUid = firstWithDs.datasourceUid;
      }
    } catch {
      // use the default
    }

    const effectiveStep = step ?? this.opts.defaultStep;
    const resp = await this.client.datasourceRange(dsUid, expr, from, to, effectiveStep);
    return parseRange(resp);
  }

  toEvidence(findings: MetricFinding[]): Evidence[] {
    return findingsToEvidence(
      findings.filter((f) => f.anomaly !== 'none'),
      'grafana.analyze',
      new Date().toISOString(),
    );
  }
}
