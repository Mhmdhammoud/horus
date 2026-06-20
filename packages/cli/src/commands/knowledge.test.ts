import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJsonKnowledgeStore,
  knowledgePath,
  KnowledgeSnapshotSchema,
  KNOWLEDGE_SCHEMA_VERSION,
} from '@horus/knowledge';
import {
  runKnowledgeStatus,
  runKnowledgeSearch,
  runKnowledgeContracts,
  runKnowledgeTrace,
  runKnowledgeAsk,
  runKnowledgeValidate,
} from './knowledge.js';

const NOW = '2026-06-19T15:00:00.000Z';
const prov = { sourceType: 'imported' as const, repo: 'maison', filePath: 'src/x.ts' };

function fixtureSnapshot() {
  return KnowledgeSnapshotSchema.parse({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: NOW,
    project: 'maison',
    operations: [
      {
        id: 'operation:createSale',
        provenance: { ...prov, filePath: 'src/resolvers/sale.ts' },
        name: 'createSale',
        kind: 'mutation',
        domain: 'sales',
        args: [{ name: 'input', type: 'CreateSaleInput', nullable: false }],
        returnType: 'SaleResponse',
        auth: { required: true, roles: ['admin'] },
      },
    ],
    types: [
      {
        id: 'type:CreateSaleInput',
        provenance: prov,
        name: 'CreateSaleInput',
        kind: 'input',
        fields: [{ name: 'title', type: 'string', nullable: false }],
      },
    ],
    enums: [{ id: 'enum:SaleStatus', provenance: prov, name: 'SaleStatus', values: ['DRAFT', 'ACTIVE'] }],
    domainConcepts: [
      {
        id: 'concept:flash-sale',
        provenance: { sourceType: 'inferred', confidence: 'medium' },
        name: 'Flash Sale',
        slug: 'flash-sale',
        summary: 'Time-limited shopping events',
        relatedOperations: ['createSale'],
        relatedTypes: ['CreateSaleInput'],
      },
    ],
  });
}

const dirs: string[] = [];
let logs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
});
afterEach(() => {
  logSpy.mockRestore();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

// Strip ANSI color codes so assertions are color-agnostic. picocolors enables
// color when CI/GITHUB_ACTIONS is set (but not under a plain local vitest run),
// which would otherwise insert escapes between tokens and break `toMatch`.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function out(): string {
  return logs.join('\n').replace(ANSI, '');
}
function emptyRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-kn-empty-'));
  dirs.push(d);
  return d;
}
function indexedRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-kn-'));
  dirs.push(d);
  createJsonKnowledgeStore(d).write(fixtureSnapshot(), {
    generator: { tool: 'horus-cli' },
    git: { sha: 'a'.repeat(40), branch: 'work' },
  });
  return d;
}

describe('horus knowledge — no index', () => {
  it('status reports no index (exit 0)', () => {
    expect(runKnowledgeStatus({ root: emptyRoot() })).toBe(0);
    expect(out()).toMatch(/No project-knowledge index/);
  });
  it('search errors with no index (exit 1)', () => {
    expect(runKnowledgeSearch('x', { root: emptyRoot() })).toBe(1);
  });
  it('validate fails with no index (exit 1)', () => {
    expect(runKnowledgeValidate({ root: emptyRoot() })).toBe(1);
  });
});

describe('horus knowledge — with an index', () => {
  it('status shows schema version, last commit, and counts', () => {
    expect(runKnowledgeStatus({ root: indexedRoot() })).toBe(0);
    const o = out();
    expect(o).toMatch(/schema version: 1/);
    expect(o).toMatch(/last commit:\s+aaaaaaaa \(work\)/);
    expect(o).toMatch(/operations: 1/);
  });

  it('search finds operations and concepts', () => {
    const root = indexedRoot();
    runKnowledgeSearch('createSale', { root });
    expect(out()).toMatch(/\[operations\] createSale/);
    logs = [];
    runKnowledgeSearch('flash', { root });
    expect(out()).toMatch(/\[domainConcepts\] Flash Sale/);
  });

  it('search reports no matches cleanly', () => {
    runKnowledgeSearch('zzzznotfound', { root: indexedRoot() });
    expect(out()).toMatch(/No matches/);
  });

  it('contracts prints operation/type/enum verbatim', () => {
    const root = indexedRoot();
    runKnowledgeContracts('createSale', { root });
    let o = out();
    expect(o).toMatch(/operation createSale/);
    expect(o).toMatch(/args: input: CreateSaleInput!/);
    expect(o).toMatch(/returns: SaleResponse/);

    logs = [];
    runKnowledgeContracts('SaleStatus', { root });
    expect(out()).toMatch(/values: DRAFT \| ACTIVE/);
  });

  it('trace walks concept → operations/types', () => {
    runKnowledgeTrace('flash', { root: indexedRoot() });
    const o = out();
    expect(o).toMatch(/Concept: Flash Sale/);
    expect(o).toMatch(/→ operations: createSale/);
    expect(o).toMatch(/→ types: CreateSaleInput/);
  });

  it('ask returns a grounded answer with provenance', () => {
    runKnowledgeAsk('how do sales work?', { root: indexedRoot() });
    const o = out();
    expect(o).toMatch(/Grounded in the local knowledge index/);
    expect(o).toMatch(/createSale|Flash Sale/);
  });

  it('validate passes on a clean index', () => {
    expect(runKnowledgeValidate({ root: indexedRoot() })).toBe(0);
    expect(out()).toMatch(/knowledge index is valid/);
  });

  it('validate detects a tampered knowledge-base (hash mismatch)', () => {
    const root = indexedRoot();
    // Corrupt the canonical file after write.
    const base = JSON.parse(readFileSync(knowledgePath(root, 'knowledgeBase'), 'utf8'));
    base.operations[0].name = 'tampered';
    writeFileSync(knowledgePath(root, 'knowledgeBase'), JSON.stringify(base, null, 2) + '\n');

    expect(runKnowledgeValidate({ root })).toBe(1);
    expect(out()).toMatch(/content hash does not match|count mismatch/);
  });
});
