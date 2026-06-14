/**
 * Prometheus metrics provider for @horus/connectors (HOR-11).
 * Implements metric querying, baseline comparison, spike detection, and evidence normalization.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import type { Provider } from '../contract.js';
import { PrometheusClient } from './client.js';
import {
  type MetricSeries,
  type MetricQuery,
  type SeriesSummary,
  type BaselineComparison,
  type SpikePoint,
  parseInstant,
  parseRange,
  summarize,
  compareWindows,
  detectSpikes,
  metricsToEvidence,
} from './normalize.js';

export interface MetricsProvider extends Provider {
  queryInstant(query: string): Promise<MetricSeries[]>;
  queryRange(q: MetricQuery): Promise<MetricSeries[]>;
  baseline(
    query: string,
    baselineWindow: { from: number; to: number },
    currentWindow: { from: number; to: number },
    step?: number,
  ): Promise<BaselineComparison[]>;
  spikes(
    q: MetricQuery,
    k?: number,
  ): Promise<{ labels: Record<string, string>; points: SpikePoint[] }[]>;
  toEvidence(series: MetricSeries[]): Evidence[];
}

export class PrometheusMetricsProvider implements MetricsProvider {
  readonly id = 'prometheus';
  readonly kind: ProviderKind = 'metrics';

  constructor(
    private readonly client: PrometheusClient,
    private readonly opts: { defaultStep: number },
  ) {}

  async queryInstant(query: string): Promise<MetricSeries[]> {
    const resp = await this.client.instantQuery(query);
    return parseInstant(resp);
  }

  async queryRange(q: MetricQuery): Promise<MetricSeries[]> {
    const nowSecs = Math.floor(Date.now() / 1000);
    const from = q.from ?? nowSecs - 3600;
    const to = q.to ?? nowSecs;
    const step = q.step ?? this.opts.defaultStep;
    const resp = await this.client.rangeQuery(q.query, from, to, step);
    return parseRange(resp);
  }

  async baseline(
    query: string,
    baselineWindow: { from: number; to: number },
    currentWindow: { from: number; to: number },
    step?: number,
  ): Promise<BaselineComparison[]> {
    const effectiveStep = step ?? this.opts.defaultStep;
    const [baselineSeries, currentSeries] = await Promise.all([
      this.queryRange({
        query,
        from: baselineWindow.from,
        to: baselineWindow.to,
        step: effectiveStep,
      }),
      this.queryRange({
        query,
        from: currentWindow.from,
        to: currentWindow.to,
        step: effectiveStep,
      }),
    ]);
    return compareWindows(baselineSeries, currentSeries);
  }

  async spikes(
    q: MetricQuery,
    k = 3,
  ): Promise<{ labels: Record<string, string>; points: SpikePoint[] }[]> {
    const series = await this.queryRange(q);
    const results: { labels: Record<string, string>; points: SpikePoint[] }[] = [];
    for (const s of series) {
      const points = detectSpikes(s, k);
      if (points.length > 0) {
        results.push({ labels: s.labels, points });
      }
    }
    return results;
  }

  toEvidence(series: MetricSeries[]): Evidence[] {
    const summaries: SeriesSummary[] = series.map(summarize);
    return metricsToEvidence(summaries, 'queryRange', new Date().toISOString());
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }
}
