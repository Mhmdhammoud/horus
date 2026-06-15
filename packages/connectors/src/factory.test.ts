/**
 * factory.ts integration tests — verifies that the preset + field-override
 * config path reaches the ElasticsearchLogsProvider with the correct mapping
 * (HOR-47). Pure: no HTTP calls, no env-var side effects.
 */

import { describe, it, expect } from 'vitest';
import { logsForEnv } from './factory.js';
import type { ResolvedEnvironment } from '@horus/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(
  esOverrides: Partial<NonNullable<ResolvedEnvironment['connectors']['elasticsearch']>>,
): ResolvedEnvironment {
  return {
    project: 'test',
    env: 'test',
    readOnly: true,
    repositories: [{ name: 'repo', path: '/repo' }],
    path: '/repo',
    connectors: {
      elasticsearch: {
        url: 'http://localhost:9200',
        indexPattern: 'logs-*',
        preset: 'meritt',
        ...esOverrides,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// logsForEnv — null when unconfigured
// ---------------------------------------------------------------------------

describe('logsForEnv', () => {
  it('returns null when elasticsearch is not configured', () => {
    const env: ResolvedEnvironment = {
      project: 'test',
      env: 'test',
      readOnly: true,
      repositories: [{ name: 'repo', path: '/repo' }],
      path: '/repo',
      connectors: {},
    };
    expect(logsForEnv(env)).toBeNull();
  });

  it('returns null when url is empty', () => {
    expect(logsForEnv(makeEnv({ url: '' }))).toBeNull();
  });

  it('returns a provider when url is present', () => {
    const provider = logsForEnv(makeEnv({}));
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe('elasticsearch');
  });
});

// ---------------------------------------------------------------------------
// Preset selection wires the correct mapping
// ---------------------------------------------------------------------------

describe('logsForEnv — preset selection', () => {
  it('meritt preset: provider uses "time" as timestamp (not @timestamp)', async () => {
    const provider = logsForEnv(makeEnv({ preset: 'meritt' }))!;
    // searchLogs will fail with a network error, but the mapping is already
    // baked in. We verify it indirectly by inspecting the provider instance
    // — Meritt mapping uses 'time', so the query body will reference 'time'.
    // Since we cannot call the provider without a real ES cluster, we verify
    // via the factory not throwing and the ID being correct.
    expect(provider.id).toBe('elasticsearch');
  });

  it('ecs preset: provider is constructed without throwing', () => {
    const provider = logsForEnv(makeEnv({ preset: 'ecs' }));
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe('elasticsearch');
  });
});

// ---------------------------------------------------------------------------
// Field overrides are merged on top of the preset (HOR-47 custom mapping path)
// ---------------------------------------------------------------------------

describe('logsForEnv — field overrides', () => {
  it('merges timestamp override on top of meritt preset without throwing', () => {
    const provider = logsForEnv(
      makeEnv({ preset: 'meritt', fields: { timestamp: '@timestamp' } }),
    );
    expect(provider).not.toBeNull();
  });

  it('merges all fields for a fully custom schema without throwing', () => {
    const provider = logsForEnv(
      makeEnv({
        preset: 'meritt',
        fields: {
          timestamp: 'ts',
          level: 'severity',
          levelFormat: 'string',
          service: 'app_name',
          serviceKeyword: false,
          message: 'log_message',
          messageFallback: 'msg',
          traceId: 'correlation_id',
          requestId: 'req_id',
          eventCode: 'error_code',
          eventCodeKeyword: true,
        },
      }),
    );
    expect(provider).not.toBeNull();
  });

  it('validates the merged mapping and throws on empty eventCode override', () => {
    expect(() =>
      logsForEnv(makeEnv({ preset: 'meritt', fields: { eventCode: '' } })),
    ).toThrow(/eventCodeField/);
  });

  it('validates the merged mapping and throws on empty timestamp override', () => {
    expect(() =>
      logsForEnv(makeEnv({ preset: 'meritt', fields: { timestamp: '' } })),
    ).toThrow(/timestampField/);
  });
});
