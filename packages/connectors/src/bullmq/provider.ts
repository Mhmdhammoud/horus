/**
 * Queue runtime evidence provider (HOR-12).
 *
 * Reads live BullMQ state from Redis and converts it into typed Evidence:
 * backlog depth, failed counts and error breakdown, delayed accumulation,
 * oldest-job age, and worker starvation. No raw Redis data reaches the engine.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import type { Provider } from '../contract.js';
import { BullMQRedisClient } from './client.js';
import {
  type QueueCounts,
  type QueueRuntimeState,
  queueStateToEvidence,
} from './analyze.js';

export interface QueueRuntimeProvider extends Provider {
  analyzeQueues(opts?: { queueNames?: string[] }): Promise<QueueRuntimeState>;
  /** Discover queue names present in Redis (regardless of static topology). */
  discoverQueues(): Promise<string[]>;
  toEvidence(state: QueueRuntimeState): Evidence[];
  close(): Promise<void>;
}

/** Number of recent failed jobs to sample for error-breakdown evidence. */
const FAILED_SAMPLE = 20;

export class BullMQRuntimeProvider implements QueueRuntimeProvider {
  readonly id = 'bullmq';
  readonly kind: ProviderKind = 'queue';

  constructor(private readonly client: BullMQRedisClient) {}

  async analyzeQueues(opts: { queueNames?: string[] } = {}): Promise<QueueRuntimeState> {
    const collectedAt = new Date().toISOString();
    let names = opts.queueNames ?? [];
    if (names.length === 0) {
      names = await this.client.discoverQueues();
    }

    const queues = await Promise.all(names.map((name) => this.inspectQueue(name)));
    return { prefix: this.client.prefix, collectedAt, queues };
  }

  /** Discover queue names present in Redis under the configured prefix. */
  discoverQueues(): Promise<string[]> {
    return this.client.discoverQueues();
  }

  private async inspectQueue(name: string): Promise<QueueCounts> {
    const [waiting, active, failed, delayed, completed, paused] = await Promise.all([
      this.client.listLen(this.client.queueKey(name, 'wait')),
      this.client.listLen(this.client.queueKey(name, 'active')),
      this.client.sortedSetCard(this.client.queueKey(name, 'failed')),
      this.client.sortedSetCard(this.client.queueKey(name, 'delayed')),
      this.client.sortedSetCard(this.client.queueKey(name, 'completed')),
      this.client.listLen(this.client.queueKey(name, 'paused')),
    ]);

    const counts: QueueCounts = {
      queueName: name,
      waiting,
      active,
      failed,
      delayed,
      completed,
      paused,
      isPaused: paused > 0,
    };

    // Oldest waiting job: BullMQ LPUSHes new jobs (index 0 = newest); workers
    // RPOPLPUSH from the tail, so the oldest unprocessed job is at index -1.
    if (waiting > 0) {
      const oldestJobId = await this.client.listIndex(this.client.queueKey(name, 'wait'), -1);
      if (oldestJobId !== null) {
        const fields = await this.client.jobFields(name, oldestJobId, ['timestamp']);
        const ts = fields['timestamp'];
        if (ts !== undefined) {
          const created = Number(ts);
          if (!Number.isNaN(created) && created > 0) {
            counts.oldestWaitingMs = Date.now() - created;
          }
        }
      }
    }

    // Failed breakdown: sample the most recent failed jobs, group by error message.
    // Also read each job's `finishedOn` (epoch ms, set by BullMQ when a job fails)
    // so callers can tell a live failure from a stale one (HOR-217).
    if (failed > 0) {
      const failedJobIds = await this.client.sortedSetTail(
        this.client.queueKey(name, 'failed'),
        FAILED_SAMPLE,
      );
      const [reasons, finished] = await Promise.all([
        this.client.pipelineHget(name, failedJobIds, 'failedReason'),
        this.client.pipelineHget(name, failedJobIds, 'finishedOn'),
      ]);
      const now = Date.now();
      // Per-reason: count + the most recent finishedOn (epoch ms) seen for it.
      const byReason = new Map<string, { count: number; newestFinished: number }>();
      let newestFinishedOverall = 0;
      for (let i = 0; i < failedJobIds.length; i++) {
        const r = reasons[i];
        if (r === null || r === undefined || r === '') continue;
        // First line only — avoid folding distinct stack traces into one bucket
        const key = r.split('\n')[0]!.trim().slice(0, 120);
        const finRaw = finished[i];
        const fin = finRaw !== null && finRaw !== undefined ? Number(finRaw) : NaN;
        const hasFin = Number.isFinite(fin) && fin > 0;
        const entry = byReason.get(key) ?? { count: 0, newestFinished: 0 };
        entry.count += 1;
        if (hasFin && fin > entry.newestFinished) entry.newestFinished = fin;
        byReason.set(key, entry);
        if (hasFin && fin > newestFinishedOverall) newestFinishedOverall = fin;
      }
      counts.failedBreakdown = [...byReason.entries()]
        .map(([reason, v]) => ({
          reason,
          count: v.count,
          ...(v.newestFinished > 0 ? { lastFailedAgeMs: Math.max(0, now - v.newestFinished) } : {}),
        }))
        .sort((a, b) => b.count - a.count);
      if (newestFinishedOverall > 0) {
        counts.newestFailedAgeMs = Math.max(0, now - newestFinishedOverall);
      }
    }

    return counts;
  }

  toEvidence(state: QueueRuntimeState): Evidence[] {
    return queueStateToEvidence(state, 'queue.analyzeQueues', state.collectedAt);
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
