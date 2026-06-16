/**
 * Unit tests for BullMQRedisClient.discoverQueues.
 *
 * Regression guard: discovery must scan `:meta` keys (written when a queue is
 * instantiated, present even when idle), NOT `:wait` keys (only present when jobs
 * are pending). Scanning `:wait` made idle-but-real queues invisible, so
 * `horus queues --live` showed nothing for queues with no backlog.
 */
import { describe, it, expect } from 'vitest';
import { BullMQRedisClient } from './client.js';

/** Swap in a fake ioredis whose `scan` returns the given keys in one page. */
function withFakeScan(
  client: BullMQRedisClient,
  onScan: (pattern: string) => string[],
): { patterns: string[] } {
  const patterns: string[] = [];
  // lazyConnect:true means no real socket was opened; replace the private field.
  (client as unknown as { redis: unknown }).redis = {
    scan: async (_cursor: string, _match: string, pattern: string) => {
      patterns.push(pattern);
      return ['0', onScan(pattern)];
    },
  };
  return { patterns };
}

describe('BullMQRedisClient.discoverQueues', () => {
  it('discovers queue names from :meta keys (idle queues included)', async () => {
    const client = new BullMQRedisClient({ url: 'redis://127.0.0.1:6379', prefix: 'bull' });
    const { patterns } = withFakeScan(client, () => [
      'bull:SEED_INSTA:meta',
      'bull:GAIA_FULL_SYNC:meta',
      'bull:brand-webhooks:meta',
    ]);

    const names = await client.discoverQueues();

    // Must scan :meta, never :wait (the old, backlog-only behaviour).
    expect(patterns).toEqual(['bull:*:meta']);
    expect(names.sort()).toEqual(['GAIA_FULL_SYNC', 'SEED_INSTA', 'brand-webhooks']);
  });

  it('honours a custom prefix', async () => {
    const client = new BullMQRedisClient({ url: 'redis://127.0.0.1:6379', prefix: 'myapp' });
    const { patterns } = withFakeScan(client, () => ['myapp:orders:meta']);

    const names = await client.discoverQueues();

    expect(patterns).toEqual(['myapp:*:meta']);
    expect(names).toEqual(['orders']);
  });

  it('returns an empty list when no queues exist', async () => {
    const client = new BullMQRedisClient({ url: 'redis://127.0.0.1:6379', prefix: 'bull' });
    withFakeScan(client, () => []);
    expect(await client.discoverQueues()).toEqual([]);
  });
});
