/**
 * Elasticsearch logs provider for @horus/connectors (HOR-10).
 * Implements collection + normalization only — no AI logic.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import type { Provider } from '../contract.js';
import { ElasticsearchClient } from './client.js';
import {
  type LogRecord,
  type LogQuery,
  type ErrorBucket,
  type ErrorDelta,
  buildSearchBody,
  buildErrorAggBody,
  hitsToRecords,
  aggToErrorBuckets,
  computeErrorDeltas,
  logsToEvidence,
} from './normalize.js';
import {
  type LogAnalysis,
  buildErrorAnalysisBody,
  parseErrorAnalysis,
  annotateAgainstBaseline,
} from './analyze.js';

export interface LogsProvider extends Provider {
  searchLogs(q: LogQuery): Promise<LogRecord[]>;
  aggregateErrors(q: LogQuery, field?: string): Promise<ErrorBucket[]>;
  errorDeltas(
    baseline: LogQuery,
    current: LogQuery,
    field?: string,
  ): Promise<ErrorDelta[]>;
  /**
   * Synthesize error EVIDENCE (not raw logs): distinct signatures with
   * first/last occurrence, affected services, and NEW/spike flags computed
   * against the preceding window.
   */
  analyzeErrors(q: LogQuery, field?: string): Promise<LogAnalysis>;
  toEvidence(records: LogRecord[]): Evidence[];
}

export class ElasticsearchLogsProvider implements LogsProvider {
  readonly id = 'elasticsearch';
  readonly kind: ProviderKind = 'logs';

  constructor(
    private readonly client: ElasticsearchClient,
    private readonly opts: { indexPattern: string },
  ) {}

  private resolveIndex(q: LogQuery): string {
    return q.index ?? this.opts.indexPattern;
  }

  async searchLogs(q: LogQuery): Promise<LogRecord[]> {
    const res = await this.client.search(this.resolveIndex(q), buildSearchBody(q));
    return hitsToRecords(res);
  }

  async aggregateErrors(q: LogQuery, field = 'event_code'): Promise<ErrorBucket[]> {
    const res = await this.client.search(
      this.resolveIndex(q),
      buildErrorAggBody(q, field),
    );
    return aggToErrorBuckets(res);
  }

  async errorDeltas(
    baseline: LogQuery,
    current: LogQuery,
    field = 'event_code',
  ): Promise<ErrorDelta[]> {
    const [baselineBuckets, currentBuckets] = await Promise.all([
      this.aggregateErrors(baseline, field),
      this.aggregateErrors(current, field),
    ]);
    return computeErrorDeltas(baselineBuckets, currentBuckets);
  }

  async analyzeErrors(q: LogQuery, field = 'event_code'): Promise<LogAnalysis> {
    // Default to a 24h window when none is given.
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.now() - 86_400_000).toISOString();

    const current = { ...q, from, to };
    const curRes = await this.client.search(
      this.resolveIndex(q),
      buildErrorAnalysisBody(current, field),
    );
    const analysis = parseErrorAnalysis(curRes, { from, to });

    // Baseline = the immediately preceding window of equal length, so we can flag
    // NEW signatures and spikes. Best-effort: skip if the window can't be parsed.
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isNaN(fromMs) && !Number.isNaN(toMs) && toMs > fromMs) {
      const span = toMs - fromMs;
      const baselineQ = {
        ...q,
        from: new Date(fromMs - span).toISOString(),
        to: from,
      };
      const baseRes = await this.client.search(
        this.resolveIndex(q),
        buildErrorAnalysisBody(baselineQ, field),
      );
      const baseline = parseErrorAnalysis(baseRes, {});
      annotateAgainstBaseline(analysis, baseline.signatures);
    }

    return analysis;
  }

  toEvidence(records: LogRecord[]): Evidence[] {
    return logsToEvidence(records, 'searchLogs', new Date().toISOString());
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }
}
