import { describe, it, expect, beforeAll } from 'vitest';
import { AxonHttpClient, AxonHttpError } from './client.js';

const baseUrl = process.env.AXON_HOST_URL ?? 'http://127.0.0.1:8420';
const client = new AxonHttpClient({ baseUrl });

let hostUp = false;

beforeAll(async () => {
  hostUp = (await client.health()).ok;
});

describe('Axon HTTP API contract', () => {
  it('cypher returns a node count', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const r = await client.cypher('MATCH (n) RETURN count(n) AS n');
    expect(r.rowCount).toBe(1);
    expect(Array.isArray(r.rows)).toBe(true);
    expect(typeof r.rows[0]?.[0]).toBe('number');
    expect(Number(r.rows[0]?.[0])).toBeGreaterThan(0);
    expect(Array.isArray(r.columns)).toBe(true);
  });

  it('search returns symbols for a semantic query', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const res = await client.search('refresh token', 5);
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThan(0);
    const first = res[0];
    expect(typeof first?.nodeId).toBe('string');
    expect(typeof first?.name).toBe('string');
    expect(typeof first?.filePath).toBe('string');
    expect(typeof first?.score).toBe('number');
  });

  it('impact returns target and affected', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const idRes = await client.cypher('MATCH (n:Method) RETURN n.id AS id LIMIT 1');
    const id = String(idRes.rows[0]?.[0]);
    const imp = await client.impact(id, 2);
    expect(imp.target.id).toBe(id);
    expect(typeof imp.affected).toBe('number');
    expect(typeof imp.depths).toBe('object');
  });

  it('diff returns added/removed/modified arrays', async (ctx) => {
    if (!hostUp) return ctx.skip();

    try {
      const d = await client.diff('HEAD~3', 'HEAD');
      expect(Array.isArray(d.added)).toBe(true);
      expect(Array.isArray(d.removed)).toBe(true);
      expect(Array.isArray(d.modified)).toBe(true);
    } catch (e) {
      if (e instanceof AxonHttpError && e.status === 400) return ctx.skip();
      throw e;
    }
  });

  it('overview exposes node label counts', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const o = await client.overview();
    expect(typeof o.totalNodes).toBe('number');
    expect(typeof o.nodesByLabel).toBe('object');
  });
});
