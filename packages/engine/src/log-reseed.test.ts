/**
 * HOR-215 / HOR-216 — entity detection and log-search seed fallback.
 *
 * detectEntityFields finds id-like context keys to aggregate ("16 brands");
 * reseedFromLogs lets a raw error-string hint resolve to a source symbol via the
 * matching log's component when source search alone finds nothing.
 */
import { describe, it, expect } from 'vitest';
import type { Symbol } from '@horus/core';
import type { CodeProvider, LogsProvider, LogRecord } from '@horus/connectors';
import { detectEntityFields, reseedFromLogs } from './engine.js';
import type { EngineDeps } from './engine.js';

describe('detectEntityFields (HOR-215)', () => {
  it('picks id-like context keys', () => {
    const fields = detectEntityFields({
      brand_id: '666',
      brand_order_id: '5275',
      message: 'Error checking fulfillment',
      error: 'Access denied',
    });
    expect(fields).toContain('brand_id');
    expect(fields).toContain('brand_order_id');
    expect(fields).not.toContain('message');
  });

  it('ignores non-scalar values and caps the count', () => {
    const fields = detectEntityFields(
      { user_id: '1', account_id: '2', shop_id: '3', payload: { nested: true } },
      2,
    );
    expect(fields).toHaveLength(2);
    expect(fields).not.toContain('payload');
  });

  it('returns nothing for undefined context', () => {
    expect(detectEntityFields(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reseedFromLogs
// ---------------------------------------------------------------------------

const GAIA_SYMBOL: Symbol = {
  id: 'sym:GaiaApiClient',
  name: 'GaiaApiClient',
  filePath: 'src/clients/gaia-api.client.ts',
  startLine: 5,
};

function makeCode(symbolsByQuery: Record<string, Symbol[]>): CodeProvider {
  return {
    id: 'fake-code',
    kind: 'code',
    async health() {
      return { ok: true, detail: '' };
    },
    async searchSymbols(query: string): Promise<Symbol[]> {
      return symbolsByQuery[query] ?? [];
    },
    async context() {
      throw new Error('not used');
    },
    async impact() {
      throw new Error('not used');
    },
    async flowsFor() {
      return [];
    },
    async detectChanges() {
      return { added: [], removed: [], modified: [] };
    },
    async cypher() {
      return { columns: [], rows: [], rowCount: 0 };
    },
  } as unknown as CodeProvider;
}

function makeLogs(records: LogRecord[]): LogsProvider {
  return {
    id: 'fake-logs',
    kind: 'logs',
    async health() {
      return { ok: true, detail: '' };
    },
    async searchLogs() {
      return records;
    },
  } as unknown as LogsProvider;
}

const GAIA_LOG: LogRecord = {
  timestamp: new Date().toISOString(),
  level: 'error',
  levelValue: 50,
  message: 'Gaia request failed',
  component: 'GaiaApiClient',
  eventCode: 'ERR_GAIA003_02',
  detail: 'getaddrinfo ENOTFOUND monnier.strapi.gaiasuite.com',
  index: 'logs',
  raw: {},
};

describe('reseedFromLogs (HOR-216)', () => {
  it('resolves a raw error-string hint via the matching log component', async () => {
    const deps = {
      code: makeCode({ GaiaApiClient: [GAIA_SYMBOL] }),
      logs: makeLogs([GAIA_LOG]),
    } as unknown as EngineDeps;

    const result = await reseedFromLogs(
      'getaddrinfo ENOTFOUND monnier.strapi.gaiasuite.com',
      { hint: 'getaddrinfo ENOTFOUND monnier.strapi.gaiasuite.com' },
      deps,
    );
    expect(result).not.toBeNull();
    expect(result!.seeds[0]!.name).toBe('GaiaApiClient');
    expect(result!.note).toContain('GaiaApiClient');
    expect(result!.note).toContain('ERR_GAIA003_02');
    expect(result!.component).toBe('GaiaApiClient');
  });

  it('returns null when no logs match', async () => {
    const deps = {
      code: makeCode({ GaiaApiClient: [GAIA_SYMBOL] }),
      logs: makeLogs([]),
    } as unknown as EngineDeps;
    const result = await reseedFromLogs('nothing', { hint: 'nothing' }, deps);
    expect(result).toBeNull();
  });

  it('returns null when the component resolves to no symbol', async () => {
    const deps = {
      code: makeCode({}), // no symbol for any query
      logs: makeLogs([GAIA_LOG]),
    } as unknown as EngineDeps;
    const result = await reseedFromLogs('boom', { hint: 'boom' }, deps);
    expect(result).toBeNull();
  });

  it('returns null when logs are not configured', async () => {
    const deps = { code: makeCode({}) } as unknown as EngineDeps;
    const result = await reseedFromLogs('boom', { hint: 'boom' }, deps);
    expect(result).toBeNull();
  });
});
