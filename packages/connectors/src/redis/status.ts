/**
 * Redis server + per-DB status (HOR-201) — powers the multi-DB view in `horus status`.
 * Probes each configured logical DB read-only: a ping plus either a queue count
 * (bullmq DBs) or a key count (cache/state DBs).
 */

import type { ResolvedEnvironment, RedisRole } from '@horus/core';
import { redisUrlForDb, REDIS_QUEUE_ROLES } from '@horus/core';
import { RedisScanClient } from './scan-client.js';

export interface RedisDbStatus {
  db: number;
  name?: string;
  roles: RedisRole[];
  reachable: boolean;
  detail?: string;
  /** Key count for state DBs (DBSIZE). */
  keyCount?: number;
  /** Queue count for bullmq DBs. */
  queueCount?: number;
  bullmqPrefix?: string;
}

export interface RedisServerStatus {
  /** True when at least one DB responded to PING. */
  reachable: boolean;
  /** True when a DB failed PING with an auth error (WRONGPASS/NOAUTH). */
  authFailed: boolean;
  databases: RedisDbStatus[];
}

/**
 * Probe the Redis server and each configured logical DB. Returns null when no Redis
 * connector (URL) is configured.
 */
export async function redisServerStatus(
  renv: ResolvedEnvironment,
): Promise<RedisServerStatus | null> {
  const r = renv.connectors.redis;
  if (!r?.url) return null;
  const url = r.url;

  let reachable = false;
  let authFailed = false;
  const databases: RedisDbStatus[] = [];

  for (const d of r.databases) {
    const client = new RedisScanClient({ url: redisUrlForDb(url, d.db), db: d.db });
    try {
      const health = await client.health();
      const isQueue = d.roles.some((role) => REDIS_QUEUE_ROLES.includes(role));
      if (!health.ok) {
        if (/WRONGPASS|NOAUTH|invalid password/i.test(health.detail)) authFailed = true;
        databases.push({
          db: d.db,
          ...(d.name !== undefined ? { name: d.name } : {}),
          roles: d.roles,
          reachable: false,
          detail: health.detail,
        });
        continue;
      }
      reachable = true;
      if (isQueue) {
        const queues = await client.detectBullmqQueues(d.bullmqPrefix);
        databases.push({
          db: d.db,
          ...(d.name !== undefined ? { name: d.name } : {}),
          roles: d.roles,
          reachable: true,
          queueCount: queues.length,
          bullmqPrefix: d.bullmqPrefix,
        });
      } else {
        const keyCount = await client.dbSize();
        databases.push({
          db: d.db,
          ...(d.name !== undefined ? { name: d.name } : {}),
          roles: d.roles,
          reachable: true,
          keyCount,
        });
      }
    } finally {
      await client.close();
    }
  }

  return { reachable, authFailed, databases };
}
