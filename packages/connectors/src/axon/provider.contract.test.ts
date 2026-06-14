/**
 * AxonCodeProvider — live contract tests.
 *
 * These tests run against a real Axon host. When no host is reachable (CI without
 * Axon), every test skips cleanly so the suite stays green.
 *
 * Set AXON_HOST_URL to point at a non-default host, e.g.:
 *   AXON_HOST_URL=http://axon.internal:8420 pnpm test provider.contract
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AxonHttpClient, AxonHttpError } from './client.js';
import { AxonCodeProvider } from './provider.js';

const baseUrl = process.env['AXON_HOST_URL'] ?? 'http://127.0.0.1:8420';
const client = new AxonHttpClient({ baseUrl });
const provider = new AxonCodeProvider(client);

let hostUp = false;

beforeAll(async () => {
  hostUp = (await client.health()).ok;
});

describe('AxonCodeProvider contract', () => {
  it('searchSymbols returns symbols', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const s = await provider.searchSymbols('refresh token', 5);
    expect(Array.isArray(s)).toBe(true);
    expect(s.length).toBeGreaterThan(0);
    expect(typeof s[0]?.id).toBe('string');
    expect(typeof s[0]?.name).toBe('string');
    expect(typeof s[0]?.filePath).toBe('string');
  });

  it('context returns the full relationship set', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const r = await client.cypher('MATCH (n:Method) RETURN n.id AS id LIMIT 1');
    const id = String(r.rows[0]?.[0]);
    const c = await provider.context(id);

    expect(c.symbol.id).toBe(id);
    expect(Array.isArray(c.callers)).toBe(true);
    expect(Array.isArray(c.callees)).toBe(true);
    expect(Array.isArray(c.usesType)).toBe(true);
    expect(Array.isArray(c.imports)).toBe(true);
    expect(Array.isArray(c.coupledWith)).toBe(true);
    expect(c.community === null || typeof c.community?.name === 'string').toBe(true);
  });

  it('member_of community resolves for a known symbol (semantic guard)', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const knownId =
      'method:src/modules/zoho/zoho-oauth.service.ts:ZohoOAuthService.refreshAccessToken';
    const escapedId =
      'method:src/modules/zoho/zoho-oauth.service.ts:ZohoOAuthService.refreshAccessToken';
    const exists = (
      await client.cypher(
        `MATCH (n) WHERE n.id = "${escapedId}" RETURN n.id`,
      )
    ).rowCount;

    if (!exists) return ctx.skip();

    const c = await provider.context(knownId);
    expect(c.community).not.toBeNull();
    expect(typeof c.community?.name).toBe('string');
    expect(c.callees.length + c.callers.length).toBeGreaterThan(0);
  });

  it('flowsFor returns ordered flows', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const r = await client.cypher(
      'MATCH (s)-[rel:CodeRelation]->(p:Process) WHERE rel.rel_type = "step_in_process" RETURN s.id AS id LIMIT 1',
    );
    if (!r.rowCount) return ctx.skip();

    const id = String(r.rows[0]?.[0]);
    const flows = await provider.flowsFor(id);

    expect(flows.length).toBeGreaterThan(0);
    const f = flows[0];
    expect(typeof f?.id).toBe('string');
    expect(typeof f?.name).toBe('string');
    expect(Array.isArray(f?.steps)).toBe(true);
    expect(f?.steps.length ?? 0).toBeGreaterThan(0);
  });

  it('impact returns target + byDepth', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const r = await client.cypher('MATCH (n:Method) RETURN n.id AS id LIMIT 1');
    const id = String(r.rows[0]?.[0]);
    const imp = await provider.impact(id, 2);

    expect(imp.target.id).toBe(id);
    expect(typeof imp.affected).toBe('number');
    expect(Array.isArray(imp.byDepth)).toBe(true);
  });

  it('detectChanges returns change arrays', async (ctx) => {
    if (!hostUp) return ctx.skip();

    try {
      const d = await provider.detectChanges({ base: 'HEAD~3', compare: 'HEAD' });
      expect(Array.isArray(d.added)).toBe(true);
      expect(Array.isArray(d.removed)).toBe(true);
      expect(Array.isArray(d.modified)).toBe(true);
    } catch (e) {
      if (e instanceof AxonHttpError && e.status === 400) return ctx.skip();
      throw e;
    }
  });

  it('cypher passthrough returns rows', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const res = await provider.cypher('MATCH (n) RETURN count(n)');
    expect(res.rowCount).toBe(1);
    expect(Array.isArray(res.rows)).toBe(true);
  });
});
