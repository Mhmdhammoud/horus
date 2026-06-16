/**
 * Redis multi-DB discovery (HOR-201) — scan logical DBs on a server to suggest how
 * each should be configured. Used by `horus connect redis`. Read-only and bounded:
 * every DB probe is a DBSIZE + a capped SCAN sample, never a full keyspace read.
 */

import type { RedisRole } from '@horus/core';
import { RedisScanClient, type KeyPrefixSample } from './scan-client.js';

export interface RedisDbProbe {
  db: number;
  reachable: boolean;
  /** Error detail when unreachable (e.g. auth failure). */
  detail?: string;
  keyCount: number;
  /** Top key prefixes sampled from this DB. */
  prefixes: KeyPrefixSample[];
  /** BullMQ queue names detected via `{prefix}:*:meta`. */
  bullmqQueues: string[];
  /** The BullMQ prefix that matched, when queues were found. */
  bullmqPrefix?: string;
  /** Roles suggested from the probe — a starting point for the user to confirm. */
  suggestedRoles: RedisRole[];
}

export interface ProbeOpts {
  /** DB indices to scan. Default 0–15. */
  dbRange?: number[];
  /** Max keys sampled per DB. Default 500. */
  sampleLimit?: number;
  /** BullMQ prefix to look for. Default "bull". */
  bullmqPrefix?: string;
}

/** Infer roles for a non-queue DB from its sampled key prefixes. */
function inferStateRoles(prefixes: KeyPrefixSample[]): RedisRole[] {
  const roles = new Set<RedisRole>(['cache', 'state']);
  for (const { prefix } of prefixes) {
    const p = prefix.toLowerCase();
    if (/lock/.test(p)) roles.add('locks');
    if (/rate.?limit|throttle/.test(p)) roles.add('rate-limit');
    if (/session|sess/.test(p)) roles.add('session');
    if (/dedup/.test(p)) roles.add('dedupe');
  }
  return [...roles];
}

/** Probe each DB in range and suggest a role-tagged configuration. */
export async function probeRedisDatabases(
  baseUrl: string,
  opts: ProbeOpts = {},
): Promise<RedisDbProbe[]> {
  const dbRange = opts.dbRange ?? Array.from({ length: 16 }, (_, i) => i);
  const sampleLimit = opts.sampleLimit ?? 500;
  const bullmqPrefix = opts.bullmqPrefix ?? 'bull';

  const probes: RedisDbProbe[] = [];
  for (const db of dbRange) {
    const client = new RedisScanClient({ url: baseUrl, db });
    try {
      const health = await client.health();
      if (!health.ok) {
        probes.push({
          db,
          reachable: false,
          detail: health.detail,
          keyCount: 0,
          prefixes: [],
          bullmqQueues: [],
          suggestedRoles: [],
        });
        // Auth/connection failures are server-wide — stop scanning further DBs.
        break;
      }
      const keyCount = await client.dbSize();
      if (keyCount === 0) {
        probes.push({ db, reachable: true, keyCount: 0, prefixes: [], bullmqQueues: [], suggestedRoles: [] });
        continue;
      }
      const bullmqQueues = await client.detectBullmqQueues(bullmqPrefix);
      if (bullmqQueues.length > 0) {
        probes.push({
          db,
          reachable: true,
          keyCount,
          prefixes: [],
          bullmqQueues,
          bullmqPrefix,
          suggestedRoles: ['bullmq', 'queues'],
        });
      } else {
        const prefixes = await client.samplePrefixes(sampleLimit);
        probes.push({
          db,
          reachable: true,
          keyCount,
          prefixes,
          bullmqQueues: [],
          suggestedRoles: inferStateRoles(prefixes),
        });
      }
    } finally {
      await client.close();
    }
  }
  return probes;
}
