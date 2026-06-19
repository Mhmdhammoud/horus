import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importMaisonSafqaKnowledgeBase } from './maison-safqa.js';
import { importKnowledgeBaseFile } from './index.js';
import { createJsonKnowledgeStore } from '../store.js';
import { searchSnapshot, findByName } from '../query.js';

const NOW = '2026-06-19T15:00:00.000Z';

const KB = {
  version: '1.0.0',
  generatedAt: '2026-06-18T00:00:00.000Z',
  operations: [
    {
      name: 'createSale',
      kind: 'mutation',
      resolverFile: 'src/resolvers/sale.resolver.ts',
      domain: 'sales',
      description: 'Create a flash sale',
      auth: { required: true, roles: ['admin'], notes: 'admin only' },
      args: [{ name: 'input', type: 'CreateSaleInput', nullable: false }],
      returnType: 'SaleResponse',
    },
    { kind: 'query' }, // missing name → skipped + warned
  ],
  inputTypes: [
    {
      name: 'CreateSaleInput',
      kind: 'input',
      fields: [{ name: 'title', type: 'string', nullable: false }],
      sourceFile: 'src/inputs/sale.inputs.ts',
    },
  ],
  responseTypes: [
    {
      name: 'SaleResponse',
      kind: 'response',
      fields: [{ name: 'sale', type: 'Sale', nullable: true }],
      sourceFile: 'src/responses/sale.responses.ts',
    },
  ],
  enums: [{ name: 'SaleStatus', values: ['DRAFT', 'ACTIVE'], description: 'Sale status' }],
  frontendPatterns: [
    { kind: 'hook', name: 'useSale', filePath: 'src/hooks/useSale.ts', description: 'sale hook' },
  ],
  domainConcepts: [
    {
      name: 'Flash Sale',
      slug: 'flash-sale',
      summary: 'Time-limited shopping events',
      details: 'core mechanism',
      relatedOperations: ['createSale'],
      relatedTypes: ['CreateSaleInput'],
    },
  ],
  projectProfiles: [
    {
      key: 'maison-safqa',
      name: 'maison-safqa',
      role: 'core backend',
      frameworks: ['TypeGraphQL'],
      languages: ['TypeScript'],
      integrations: ['Shopify'],
    },
  ],
  maisonSdl: 'type Query { sale: Sale }',
  weirdUnknownKey: 'x',
};

describe('importMaisonSafqaKnowledgeBase', () => {
  it('maps every category into knowledge entities tagged sourceType: imported', () => {
    const { snapshot, kbVersion } = importMaisonSafqaKnowledgeBase(KB, {
      now: NOW,
      contentHash: 'hash123',
      project: 'maison',
    });

    expect(kbVersion).toBe('1.0.0');
    expect(snapshot.operations).toHaveLength(1); // the no-name op is skipped
    expect(snapshot.operations[0]?.name).toBe('createSale');
    expect(snapshot.operations[0]?.protocol).toBe('graphql');
    expect(snapshot.operations[0]?.args[0]?.type).toBe('CreateSaleInput');
    expect(snapshot.types).toHaveLength(2); // input + response
    expect(snapshot.enums[0]?.values).toContain('DRAFT');
    expect(snapshot.domainConcepts[0]?.relatedOperations).toContain('createSale');
    expect(snapshot.repositories[0]?.frameworks).toContain('TypeGraphQL');
    expect(snapshot.frontendPatterns[0]?.name).toBe('useSale');

    // Provenance: imported, with the KB's own generatedAt + the file hash preserved.
    const prov = snapshot.operations[0]?.provenance;
    expect(prov?.sourceType).toBe('imported');
    expect(prov?.generatedAt).toBe('2026-06-18T00:00:00.000Z');
    expect(prov?.contentHash).toBe('hash123');
    expect(prov?.filePath).toBe('src/resolvers/sale.resolver.ts');
  });

  it('handles missing/unknown fields safely and reports them as warnings', () => {
    const { warnings } = importMaisonSafqaKnowledgeBase(KB, { now: NOW });
    expect(warnings.some((w) => /skipped operation/.test(w))).toBe(true);
    expect(warnings.some((w) => /maisonSdl/.test(w))).toBe(true);
    expect(warnings.some((w) => /weirdUnknownKey/.test(w))).toBe(true);
  });

  it('warns when the KB has no version', () => {
    const { warnings, kbVersion } = importMaisonSafqaKnowledgeBase(
      { operations: [{ name: 'x', kind: 'query' }] },
      { now: NOW },
    );
    expect(kbVersion).toBeNull();
    expect(warnings.some((w) => /missing a `version`/.test(w))).toBe(true);
  });

  it('throws only when the input is not KB-shaped', () => {
    expect(() => importMaisonSafqaKnowledgeBase(42, {})).toThrow();
  });
});

describe('importKnowledgeBaseFile + manifest + queryability', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  function tmp() {
    const d = mkdtempSync(join(tmpdir(), 'horus-import-'));
    dirs.push(d);
    return d;
  }

  it('imports a KB file locally, writes a provenance manifest, and round-trips', () => {
    const work = tmp();
    const root = tmp();
    const file = join(work, 'knowledge-base.json');
    writeFileSync(file, JSON.stringify(KB));

    const { snapshot, manifest, contentHash } = importKnowledgeBaseFile(file, {
      root,
      source: 'maison-safqa-mcp',
      project: 'maison',
      now: NOW,
    });

    // Manifest carries source, timestamp, hash, and schema version.
    expect(manifest).not.toBeNull();
    expect(manifest!.generator.tool).toBe('maison-safqa-mcp');
    expect(manifest!.generator.version).toBe('1.0.0');
    expect(manifest!.generatedAt).toBe(NOW);
    expect(manifest!.schemaVersion).toBe(1);
    expect(manifest!.counts.operations).toBe(1);
    const sourceFile = manifest!.files.find((f) => f.category === 'import-source');
    expect(sourceFile?.contentHash).toBe(contentHash);

    // Persisted to `.horus/index/` and reads back.
    const reread = createJsonKnowledgeStore(root).readSnapshot();
    expect(reread?.operations[0]?.name).toBe('createSale');

    // Imported items are queryable by name and keyword.
    expect(searchSnapshot(snapshot, 'createSale').some((m) => m.category === 'operations')).toBe(true);
    expect(searchSnapshot(snapshot, 'flash').some((m) => m.category === 'domainConcepts')).toBe(true);
    expect(searchSnapshot(snapshot, 'sales').length).toBeGreaterThan(0); // via operation domain
    expect(findByName(snapshot, 'SaleResponse')?.category).toBe('types');
    expect(findByName(snapshot, 'SaleStatus')?.category).toBe('enums');
  });
});
