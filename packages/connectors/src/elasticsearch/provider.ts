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
  type ElasticsearchFieldMapping,
  MERITT_FIELD_MAPPING,
  validateFieldMapping,
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
import {
  type CompatibilityOptions,
  type CompatibilityReport,
  validateMappingAgainstCaps,
} from './compat.js';

export interface LogsProvider extends Provider {
  searchLogs(q: LogQuery): Promise<LogRecord[]>;
  /**
   * Aggregate error counts by signature field. Defaults to the provider's
   * configured eventCodeField when field is omitted.
   */
  aggregateErrors(q: LogQuery, field?: string): Promise<ErrorBucket[]>;
  errorDeltas(baseline: LogQuery, current: LogQuery, field?: string): Promise<ErrorDelta[]>;
  /**
   * Synthesize error EVIDENCE (not raw logs): distinct signatures with
   * first/last occurrence, affected services, and NEW/spike flags computed
   * against the preceding window. Defaults to the provider's eventCodeField.
   */
  analyzeErrors(q: LogQuery, field?: string): Promise<LogAnalysis>;
  /**
   * Check that the configured field mapping is compatible with the actual
   * Elasticsearch index. Returns structured diagnostics with actionable
   * messages — call before investigation to surface configuration errors early.
   *
   * Pass `opts.requiresService: true` when the query will apply a service filter
   * so that a missing service field is treated as an error rather than a warning.
   */
  checkCompatibility(opts?: CompatibilityOptions): Promise<CompatibilityReport>;
  toEvidence(records: LogRecord[]): Evidence[];
}

export class ElasticsearchLogsProvider implements LogsProvider {
  readonly id = 'elasticsearch';
  readonly kind: ProviderKind = 'logs';

  private readonly mapping: ElasticsearchFieldMapping;

  constructor(
    private readonly client: ElasticsearchClient,
    private readonly opts: {
      indexPattern: string;
      /** Field mapping config. Defaults to MERITT_FIELD_MAPPING when omitted. */
      fieldMapping?: ElasticsearchFieldMapping;
    },
  ) {
    this.mapping = opts.fieldMapping ?? MERITT_FIELD_MAPPING;
    validateFieldMapping(this.mapping);
  }

  private resolveIndex(q: LogQuery): string {
    return q.index ?? this.opts.indexPattern;
  }

  async searchLogs(q: LogQuery): Promise<LogRecord[]> {
    const res = await this.client.search(
      this.resolveIndex(q),
      buildSearchBody(q, this.mapping),
    );
    return hitsToRecords(res, this.mapping);
  }

  async aggregateErrors(q: LogQuery, field?: string): Promise<ErrorBucket[]> {
    const sigField = field ?? this.mapping.eventCodeField;
    const res = await this.client.search(
      this.resolveIndex(q),
      buildErrorAggBody(q, sigField, this.mapping),
    );
    return aggToErrorBuckets(res);
  }

  async errorDeltas(
    baseline: LogQuery,
    current: LogQuery,
    field?: string,
  ): Promise<ErrorDelta[]> {
    const [baselineBuckets, currentBuckets] = await Promise.all([
      this.aggregateErrors(baseline, field),
      this.aggregateErrors(current, field),
    ]);
    return computeErrorDeltas(baselineBuckets, currentBuckets);
  }

  async analyzeErrors(q: LogQuery, field?: string): Promise<LogAnalysis> {
    const sigField = field ?? this.mapping.eventCodeField;
    // Default to a 24h window when none is given.
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.now() - 86_400_000).toISOString();

    const current = { ...q, from, to };
    const curRes = await this.client.search(
      this.resolveIndex(q),
      buildErrorAnalysisBody(current, sigField, this.mapping),
    );
    const analysis = parseErrorAnalysis(curRes, { from, to }, this.mapping.messageField);

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
        buildErrorAnalysisBody(baselineQ, sigField, this.mapping),
      );
      const baseline = parseErrorAnalysis(baseRes, {}, this.mapping.messageField);
      annotateAgainstBaseline(analysis, baseline.signatures);
    }

    return analysis;
  }

  async checkCompatibility(opts?: CompatibilityOptions): Promise<CompatibilityReport> {
    const fields = [
      this.mapping.timestampField,
      this.mapping.levelField,
      this.mapping.serviceField,
      `${this.mapping.serviceField}.keyword`,
      this.mapping.eventCodeField,
      `${this.mapping.eventCodeField}.keyword`,
      ...(this.mapping.traceIdField !== undefined ? [this.mapping.traceIdField] : []),
      ...(this.mapping.requestIdField !== undefined ? [this.mapping.requestIdField] : []),
    ];
    const caps = await this.client.fieldCaps(this.opts.indexPattern, fields);
    return validateMappingAgainstCaps(this.mapping, caps, opts);
  }

  toEvidence(records: LogRecord[]): Evidence[] {
    return logsToEvidence(records, 'searchLogs', new Date().toISOString());
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }
}
