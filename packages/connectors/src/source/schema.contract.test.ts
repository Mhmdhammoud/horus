import { describe, it, expect, beforeAll } from 'vitest';
import { SourceHttpClient, SourceHttpError } from './index.js';
import { PINNED_SOURCE_VERSION } from '@horus/core';

const baseUrl = process.env['HORUS_SOURCE_HOST_URL'] ?? 'http://127.0.0.1:8420';
const client = new SourceHttpClient({ baseUrl });
let hostUp = false;

beforeAll(async () => {
  hostUp = (await client.health()).ok;
});

describe('source-intelligence schema contract', () => {
  it('pins the source-intelligence version (openapi.json)', async (ctx) => {
    if (!hostUp) return ctx.skip();
    expect(await client.version()).toBe(PINNED_SOURCE_VERSION);
  });

  it('exposes all expected node labels', async (ctx) => {
    if (!hostUp) return ctx.skip();
    const o = await client.overview();
    const labels = Object.keys(o.nodesByLabel);
    for (const l of [
      'method',
      'class',
      'function',
      'interface',
      'typealias',
      'file',
      'folder',
      'community',
      'process',
    ]) {
      expect(labels).toContain(l);
    }
  });

  it('exposes all expected edge rel_types', async (ctx) => {
    if (!hostUp) return ctx.skip();
    const o = await client.overview();
    const types = Object.keys(o.edgesByType);
    for (const e of [
      'defines',
      'calls',
      'member_of',
      'contains',
      'uses_type',
      'imports',
      'step_in_process',
      'coupled_with',
      'implements',
    ]) {
      expect(types).toContain(e);
    }
  });

  it('uses a single CodeRelation edge table', async (ctx) => {
    if (!hostUp) return ctx.skip();
    const r = await client.cypher('MATCH ()-[r:CodeRelation]->() RETURN count(r) AS n');
    expect(r.rowCount).toBe(1);
    expect(Number(r.rows[0]?.[0])).toBeGreaterThan(0);
  });

  it('has NO per-type UPPERCASE edge tables (docs-ahead-of-build drift guard)', async (ctx) => {
    if (!hostUp) return ctx.skip();
    let err: unknown;
    try {
      await client.cypher('MATCH ()-[:CALLS]->() RETURN count(*) AS n');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SourceHttpError);
    expect((err as SourceHttpError).status).toBe(400);
  });

  it('retains snake_case node properties', async (ctx) => {
    if (!hostUp) return ctx.skip();
    const r = await client.cypher(
      'MATCH (n:Method) RETURN n.file_path, n.start_line LIMIT 1',
    );
    expect(typeof r.rows[0]?.[0]).toBe('string');
    expect(typeof r.rows[0]?.[1]).toBe('number');
  });

  it('hybrid search resolves a synonym query (semantic delegated to source backend)', async (ctx) => {
    if (!hostUp) return ctx.skip();
    const res = await client.search('deduplicate incoming leads', 5);
    expect(res.map((x) => x.name)).toContain('markDuplicateLead');
  });
});
