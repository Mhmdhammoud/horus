import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProjectKnowledge, deriveRepositoryProfile } from './project-landscape.js';
import { createJsonKnowledgeStore } from '../store.js';
import { knowledgePath } from '../layout.js';

const NOW = '2026-06-19T15:00:00.000Z';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-landscape-'));
  dirs.push(d);
  return d;
}
function repoWithPkg(pkg: object): string {
  const d = tmp();
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  return d;
}

describe('deriveRepositoryProfile', () => {
  it('detects frameworks/languages/data sources/integrations/auth + role from package.json', () => {
    const path = repoWithPkg({
      name: 'leadcall-api',
      description: 'Core API',
      dependencies: {
        express: '4',
        'drizzle-orm': '0.3',
        stripe: '14',
        '@clerk/clerk-sdk-node': '4',
      },
      devDependencies: { typescript: '5' },
      scripts: { start: 'node .', build: 'tsc', dev: 'tsx', lint: 'eslint' },
    });

    const p = deriveRepositoryProfile(
      { name: 'leadcall-api', path },
      { project: 'leadcall', gitSha: 'abc123', now: NOW },
    );

    expect(p.frameworks).toContain('Express');
    expect(p.languages).toContain('TypeScript');
    expect(p.dataSources).toContain('Drizzle (SQL)');
    expect(p.integrations).toContain('Stripe');
    expect(p.auth).toContain('Clerk');
    expect(p.role).toBe('backend');
    expect(p.mainScripts).toEqual(expect.arrayContaining(['start', 'build', 'dev', 'lint']));
    expect(p.name).toBe('leadcall-api');
    expect(p.provenance.sourceType).toBe('parsed');
    expect(p.provenance.gitSha).toBe('abc123');
    expect(p.provenance.filePath).toBe('package.json');
  });

  it('infers a frontend role and defaults language to JavaScript without TS', () => {
    const path = repoWithPkg({ name: 'web', dependencies: { next: '14', react: '18', zustand: '4' } });
    const p = deriveRepositoryProfile({ name: 'web', path }, { now: NOW });
    expect(p.frameworks).toEqual(expect.arrayContaining(['Next.js', 'React']));
    expect(p.stateManagement).toContain('Zustand');
    expect(p.role).toBe('frontend');
    expect(p.languages).toContain('JavaScript');
  });

  it('falls back to a minimal profile when package.json is missing', () => {
    const d = tmp();
    const p = deriveRepositoryProfile({ name: 'bare', path: d }, { now: NOW });
    expect(p.name).toBe('bare');
    expect(p.frameworks).toEqual([]);
    expect(p.languages).toContain('JavaScript');
    expect(p.provenance.sourceType).toBe('parsed');
  });
});

describe('buildProjectKnowledge + git-aware manifest', () => {
  it('builds a snapshot and records git sha/branch + a content hash in the manifest', () => {
    const repoPath = repoWithPkg({
      name: 'api',
      dependencies: { fastify: '4' },
      devDependencies: { typescript: '5' },
    });
    const root = tmp();

    const snapshot = buildProjectKnowledge([{ name: 'api', path: repoPath }], {
      project: 'p',
      gitSha: 'sha123',
      now: NOW,
    });
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.generatedAt).toBe(NOW);
    expect(snapshot.repositories[0]?.frameworks).toContain('Fastify');

    const manifest = createJsonKnowledgeStore(root).write(snapshot, {
      generator: { tool: 'horus-cli' },
      git: { sha: 'sha123', branch: 'work' },
      repositories: [{ name: 'api', path: repoPath, headSha: 'sha123' }],
    });

    expect(manifest.git?.sha).toBe('sha123');
    expect(manifest.git?.branch).toBe('work');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.counts.repositories).toBe(1);
    const kb = manifest.files.find((f) => f.name === 'knowledge-base.json');
    expect(kb?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(knowledgePath(root, 'knowledgeBase'))).toBe(true);

    // Round-trips.
    expect(createJsonKnowledgeStore(root).readSnapshot()?.repositories[0]?.name).toBe('api');
  });
});
