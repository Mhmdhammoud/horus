/**
 * MongoDB state-evidence provider (HOR-33). Read-only, allowlisted collections.
 * Surfaces application STATE anomalies (stale sync records, failed/disconnected
 * states, stuck schedules) as Evidence — never raw documents.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import type { Provider } from '../contract.js';
import { MongoStateClient } from './client.js';
import {
  type StateAnalysis,
  type CollectionState,
  DATE_FIELDS,
  STATUS_FIELDS,
  DEFAULT_LEGACY_HOURS,
  pickField,
  isAnomalousStatus,
  ageHoursOf,
  classifyAge,
  stateToEvidence,
} from './analyze.js';

export interface StateProvider extends Provider {
  analyzeState(opts?: { staleHours?: number }): Promise<StateAnalysis>;
  toEvidence(analysis: StateAnalysis): Evidence[];
  /** Close the underlying connection so the process can exit. */
  close(): Promise<void>;
}

export class MongoStateProvider implements StateProvider {
  readonly id = 'mongodb';
  readonly kind: ProviderKind = 'state';

  constructor(
    private readonly client: MongoStateClient,
    private readonly opts: {
      database: string;
      collections: string[];
      staleHours: number;
    },
  ) {}

  async analyzeState(
    opts: { staleHours?: number; legacyHours?: number } = {},
  ): Promise<StateAnalysis> {
    const staleHours = opts.staleHours ?? this.opts.staleHours;
    const legacyHours = opts.legacyHours ?? DEFAULT_LEGACY_HOURS;
    const nowMs = Date.now();
    const collections: CollectionState[] = [];

    for (const coll of this.opts.collections) {
      try {
        const count = await this.client.count(coll);
        const fields = await this.client.sampleFields(coll);
        const cs: CollectionState = {
          collection: coll,
          count,
          classification: 'unknown',
          anomalies: [],
        };

        const dateField = pickField(fields, DATE_FIELDS);
        if (dateField !== undefined) {
          const last = await this.client.maxDate(coll, dateField);
          if (last !== null) {
            cs.dateField = dateField;
            cs.lastActivity = last;
            cs.ageHours = ageHoursOf(last, nowMs);
            cs.isStale = cs.ageHours > staleHours;
          }
        }
        cs.classification = classifyAge(cs.ageHours, staleHours, legacyHours);

        const statusField = pickField(fields, STATUS_FIELDS);
        if (statusField !== undefined) {
          const counts = await this.client.groupBy(coll, statusField);
          cs.statusField = statusField;
          cs.statusCounts = counts;
          cs.anomalies = counts.filter((c) => isAnomalousStatus(c.value));
        }

        collections.push(cs);
      } catch {
        // A single bad/missing collection must not abort the whole analysis.
      }
    }

    return { database: this.opts.database, staleHours, legacyHours, collections };
  }

  toEvidence(analysis: StateAnalysis): Evidence[] {
    return stateToEvidence(analysis, 'mongo.analyzeState', new Date().toISOString());
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
