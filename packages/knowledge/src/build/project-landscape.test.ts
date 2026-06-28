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
function repoWithFiles(files: Record<string, string>): string {
  const d = tmp();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);
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

  it('falls back to a minimal profile with no language/provenance when no manifest exists', () => {
    const d = tmp();
    const p = deriveRepositoryProfile({ name: 'bare', path: d }, { now: NOW });
    expect(p.name).toBe('bare');
    expect(p.frameworks).toEqual([]);
    // No manifest → claim no language and cite no file (HOR-407 honesty).
    expect(p.languages).toEqual([]);
    expect(p.provenance.sourceType).toBe('parsed');
    expect(p.provenance.filePath).toBeUndefined();
  });
});

describe('deriveRepositoryProfile — Python repos (HOR-407 / HOR-408)', () => {
  it('classifies a pyproject-only repo as Python with a non-empty profile and no phantom provenance', () => {
    const path = repoWithFiles({
      'pyproject.toml': `
[project]
name = "billing-svc"
description = "Billing service"
dependencies = [
  "fastapi>=0.100",
  "sqlalchemy[asyncio]>=2.0",
  "asyncpg",
  "redis>=4",
  "celery",
  "stripe",
  "boto3 ; python_version >= '3.8'",
]
`,
    });

    const p = deriveRepositoryProfile(
      { name: 'billing-svc', path },
      { project: 'billing', gitSha: 'py123', now: NOW },
    );

    // HOR-407: language is Python, never JavaScript.
    expect(p.languages).toEqual(['Python']);
    expect(p.languages).not.toContain('JavaScript');

    // HOR-408: profile is populated from Python deps.
    expect(p.frameworks).toContain('FastAPI');
    expect(p.frameworks).toContain('Celery (queue)');
    expect(p.dataSources).toContain('SQLAlchemy');
    expect(p.dataSources).toContain('PostgreSQL'); // asyncpg
    expect(p.stateManagement).toContain('Redis');
    expect(p.integrations).toEqual(expect.arrayContaining(['Stripe', 'AWS']));
    expect(p.role).toBe('backend');
    expect(p.name).toBe('billing-svc');
    expect(p.summary).toBe('Billing service');
    expect(p.frameworks.length + p.dataSources.length).toBeGreaterThan(0);

    // HOR-407: provenance never cites a package.json that does not exist.
    expect(p.provenance.filePath).toBe('pyproject.toml');
    expect(p.provenance.filePath).not.toBe('package.json');
    expect(p.provenance.gitSha).toBe('py123');
  });

  it('reads Poetry-style pyproject dependencies', () => {
    const path = repoWithFiles({
      'pyproject.toml': `
[tool.poetry]
name = "web-svc"

[tool.poetry.dependencies]
python = "^3.11"
django = "^5.0"
psycopg2-binary = "*"
`,
    });
    const p = deriveRepositoryProfile({ name: 'web-svc', path }, { now: NOW });
    expect(p.languages).toEqual(['Python']);
    expect(p.frameworks).toContain('Django');
    expect(p.dataSources).toContain('PostgreSQL');
    expect(p.provenance.filePath).toBe('pyproject.toml');
  });

  it('reads setup.cfg install_requires and cites setup.cfg', () => {
    const path = repoWithFiles({
      'setup.cfg': `
[metadata]
name = flasky
description = A Flask app

[options]
install_requires =
    flask>=2.0
    peewee
    redis==5.0
python_requires = >=3.9
`,
    });
    const p = deriveRepositoryProfile({ name: 'flasky', path }, { now: NOW });
    expect(p.languages).toEqual(['Python']);
    expect(p.frameworks).toContain('Flask');
    expect(p.dataSources).toContain('Peewee');
    expect(p.stateManagement).toContain('Redis');
    expect(p.provenance.filePath).toBe('setup.cfg');
    expect(p.provenance.filePath).not.toBe('package.json');
  });

  it('parses setup.py install_requires and cites setup.py at high confidence (HOR-418)', () => {
    const path = repoWithFiles({
      'setup.py': `
from setuptools import setup, find_packages

setup(
    name="legacy-svc",
    description="A legacy service",
    packages=find_packages(),
    install_requires=[
        "flask>=2.0",
        "sqlalchemy[asyncio]>=2.0",
        "psycopg2-binary",
        # pinned for CVE
        "redis==5.0",
        "stripe",
    ],
)
`,
    });
    const p = deriveRepositoryProfile({ name: 'legacy-svc', path }, { now: NOW });
    expect(p.languages).toEqual(['Python']);
    expect(p.frameworks).toContain('Flask');
    expect(p.dataSources).toEqual(expect.arrayContaining(['SQLAlchemy', 'PostgreSQL']));
    expect(p.stateManagement).toContain('Redis');
    expect(p.integrations).toContain('Stripe');
    expect(p.role).toBe('backend');
    // setup.py was genuinely parsed → cite it, high confidence.
    expect(p.provenance.filePath).toBe('setup.py');
    expect(p.provenance.filePath).not.toBe('package.json');
    expect(p.provenance.confidence).toBe('high');
  });

  it('downgrades confidence and omits filePath when setup.py deps are not parseable (HOR-418)', () => {
    const path = repoWithFiles({
      // install_requires is built dynamically — nothing to extract.
      'setup.py': `
from setuptools import setup
import io

def read_reqs():
    with io.open("requirements.txt") as f:
        return f.read().splitlines()

setup(name="dyn-svc", install_requires=read_reqs())
`,
    });
    const p = deriveRepositoryProfile({ name: 'dyn-svc', path }, { now: NOW });
    // Still detected as Python...
    expect(p.languages).toEqual(['Python']);
    expect(p.frameworks).toEqual([]);
    // ...but we never claim a high-confidence parse against a file we couldn't read.
    expect(p.provenance.confidence).toBe('low');
    expect(p.provenance.filePath).toBeUndefined();
  });

  it('reads requirements.txt as a flat dependency list and cites it (HOR-419)', () => {
    const path = repoWithFiles({
      'requirements.txt': `
# Core deps
fastapi>=0.100
asyncpg
redis==5.0  # cache
boto3

-r dev-requirements.txt
-e .
--hash=sha256:abc
`,
    });
    const p = deriveRepositoryProfile({ name: 'reqs-svc', path }, { now: NOW });
    expect(p.languages).toEqual(['Python']);
    expect(p.frameworks).toContain('FastAPI');
    expect(p.dataSources).toContain('PostgreSQL'); // asyncpg
    expect(p.stateManagement).toContain('Redis');
    expect(p.integrations).toContain('AWS'); // boto3
    expect(p.role).toBe('backend');
    expect(p.provenance.filePath).toBe('requirements.txt');
    expect(p.provenance.filePath).not.toBe('package.json');
    expect(p.provenance.confidence).toBe('high');
  });

  it('treats a mixed JS + Python repo as both languages, citing package.json', () => {
    const path = repoWithPkg({ name: 'mixed', dependencies: { next: '14' } });
    writeFileSync(join(path, 'pyproject.toml'), '[project]\ndependencies = ["fastapi"]\n');
    const p = deriveRepositoryProfile({ name: 'mixed', path }, { now: NOW });
    expect(p.languages).toEqual(expect.arrayContaining(['JavaScript', 'Python']));
    expect(p.frameworks).toEqual(expect.arrayContaining(['Next.js', 'FastAPI']));
    expect(p.provenance.filePath).toBe('package.json');
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
