/**
 * Postgres state-evidence provider (HOR-CONNECTORS). Read-only, allowlisted tables.
 * Surfaces application STATE anomalies (stale sync rows, failed/stuck states) as
 * Evidence — never raw rows. Shares the analysis loop with the Mongo provider via
 * `analyzeStateWith`; only the read-only client differs.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import { PostgresStateClient } from './client.js';
import { type StateProvider, analyzeStateWith } from '../state/provider.js';
import { type StateAnalysis, DEFAULT_LEGACY_HOURS, stateToEvidence } from '../state/analyze.js';

export class PostgresStateProvider implements StateProvider {
  readonly id = 'postgres';
  readonly kind: ProviderKind = 'state';

  constructor(
    private readonly client: PostgresStateClient,
    private readonly opts: {
      database: string;
      collections: string[];
      staleHours: number;
    },
  ) {}

  async analyzeState(
    opts: { staleHours?: number; legacyHours?: number } = {},
  ): Promise<StateAnalysis> {
    return analyzeStateWith(
      this.client,
      {
        database: this.opts.database,
        collections: this.opts.collections,
        staleHours: opts.staleHours ?? this.opts.staleHours,
        legacyHours: opts.legacyHours ?? DEFAULT_LEGACY_HOURS,
      },
      Date.now(),
    );
  }

  toEvidence(analysis: StateAnalysis): Evidence[] {
    return stateToEvidence(analysis, 'postgres.analyzeState', new Date().toISOString());
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }

  async listCollections(): Promise<string[]> {
    return this.client.listCollections();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
