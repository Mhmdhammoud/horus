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

export interface LogsProvider extends Provider {
  searchLogs(q: LogQuery): Promise<LogRecord[]>;
  aggregateErrors(q: LogQuery, field?: string): Promise<ErrorBucket[]>;
  errorDeltas(
    baseline: LogQuery,
    current: LogQuery,
    field?: string,
  ): Promise<ErrorDelta[]>;
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

  toEvidence(records: LogRecord[]): Evidence[] {
    return logsToEvidence(records, 'searchLogs', new Date().toISOString());
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }
}
