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

    // Failed breakdown: sample the most recent failed jobs, group by error message
    if (failed > 0) {
      const failedJobIds = await this.client.sortedSetTail(
        this.client.queueKey(name, 'failed'),
        FAILED_SAMPLE,
      );
      const reasons = await this.client.pipelineHget(name, failedJobIds, 'failedReason');
      const byReason = new Map<string, number>();
      for (const r of reasons) {
        if (r === null || r === '') continue;
        // First line only — avoid folding distinct stack traces into one bucket
        const key = r.split('\n')[0]!.trim().slice(0, 120);
        byReason.set(key, (byReason.get(key) ?? 0) + 1);
      }
      counts.failedBreakdown = [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);
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
