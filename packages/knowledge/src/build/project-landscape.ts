/**
 * Project-landscape knowledge builder (HOR-293).
 *
 * The first-version `horus index` knowledge pass: derive a `RepositoryProfile`
 * for each repo from its `package.json` (frameworks, languages, state management,
 * auth, data sources, integrations, scripts) — local-first, no source-intelligence or network
 * required. This is the "project landscape / repo roles" scope bullet; deeper
 * extraction (GraphQL/REST contracts, types, data flows) layers on top later and
 * fills the other snapshot categories.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KnowledgeSnapshotSchema,
  KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeSnapshot,
  type Provenance,
} from '../schema.js';

interface PackageJson {
  name?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** Read + parse a repo's package.json, or null if absent/unreadable. */
export function readPackageJson(repoPath: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** dependency-name → label detection tables. */
const FRAMEWORKS: Record<string, string> = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  '@angular/core': 'Angular',
  svelte: 'Svelte',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  koa: 'Koa',
  'type-graphql': 'TypeGraphQL',
  '@apollo/server': 'Apollo Server',
  graphql: 'GraphQL',
  commander: 'Commander (CLI)',
};
const STATE: Record<string, string> = {
  redux: 'Redux',
  '@reduxjs/toolkit': 'Redux Toolkit',
  zustand: 'Zustand',
  jotai: 'Jotai',
  recoil: 'Recoil',
  pinia: 'Pinia',
  '@tanstack/react-query': 'React Query',
  '@apollo/client': 'Apollo Client',
};
const AUTH: Record<string, string> = {
  jsonwebtoken: 'JWT',
  passport: 'Passport',
  '@clerk/nextjs': 'Clerk',
  '@clerk/clerk-sdk-node': 'Clerk',
  'next-auth': 'NextAuth',
  firebase: 'Firebase Auth',
  'firebase-admin': 'Firebase Admin',
};
const DATA_SOURCES: Record<string, string> = {
  pg: 'PostgreSQL',
  postgres: 'PostgreSQL',
  'drizzle-orm': 'Drizzle (SQL)',
  mongoose: 'MongoDB',
  mongodb: 'MongoDB',
  '@prisma/client': 'Prisma',
  typeorm: 'TypeORM',
  redis: 'Redis',
  ioredis: 'Redis',
  '@elastic/elasticsearch': 'Elasticsearch',
};
const INTEGRATIONS: Record<string, string> = {
  stripe: 'Stripe',
  shopify: 'Shopify',
  '@shopify/shopify-api': 'Shopify',
  openai: 'OpenAI',
  '@anthropic-ai/sdk': 'Anthropic',
  '@aws-sdk/client-s3': 'AWS S3',
  twilio: 'Twilio',
  resend: 'Resend',
};

function detect(table: Record<string, string>, deps: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const dep of Object.keys(deps)) {
    const label = table[dep];
    if (label) out.add(label);
  }
  return [...out];
}

function detectLanguages(deps: Record<string, string>): string[] {
  const langs = new Set<string>();
  if ('typescript' in deps || Object.keys(deps).some((d) => d.startsWith('@types/'))) {
    langs.add('TypeScript');
  } else {
    langs.add('JavaScript');
  }
  return [...langs];
}

function inferRole(frameworks: string[], dataSources: string[]): string | undefined {
  const fe = ['React', 'Next.js', 'Vue', 'Nuxt', 'Angular', 'Svelte'];
  const be = ['Express', 'Fastify', 'NestJS', 'Koa', 'TypeGraphQL', 'Apollo Server'];
  const hasFe = frameworks.some((f) => fe.includes(f));
  const hasBe = frameworks.some((f) => be.includes(f));
  if (frameworks.includes('Commander (CLI)')) return 'cli';
  if (hasFe && hasBe) return 'fullstack';
  if (hasFe) return 'frontend';
  if (hasBe || dataSources.length > 0) return 'backend';
  return undefined;
}

const SCRIPT_KEYS = ['start', 'dev', 'build', 'test', 'lint', 'migrate'];

export interface RepoInput {
  name: string;
  path: string;
}

export interface BuildOptions {
  project?: string;
  /** HEAD commit the snapshot is built at (recorded on provenance). */
  gitSha?: string;
  /** ISO timestamp for the snapshot (defaults to now). */
  now?: string;
}

/** Derive a single repository profile from its package.json. */
export function deriveRepositoryProfile(repo: RepoInput, opts: BuildOptions = {}) {
  const pkg = readPackageJson(repo.path) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  const frameworks = detect(FRAMEWORKS, deps);
  const dataSources = detect(DATA_SOURCES, deps);
  const provenance: Provenance = {
    sourceType: 'parsed',
    confidence: 'high',
    repo: repo.name,
    filePath: 'package.json',
    gitSha: opts.gitSha,
    generatedAt: opts.now,
  };
  return {
    id: `repo:${repo.name}`,
    scope: opts.project ? { project: opts.project, repository: repo.name } : { repository: repo.name },
    provenance,
    key: repo.name,
    name: pkg.name ?? repo.name,
    path: repo.path,
    role: inferRole(frameworks, dataSources),
    summary: pkg.description,
    frameworks,
    languages: detectLanguages(deps),
    stateManagement: detect(STATE, deps),
    auth: detect(AUTH, deps),
    dataSources,
    mainScripts: SCRIPT_KEYS.filter((k) => pkg.scripts && k in pkg.scripts),
    integrations: detect(INTEGRATIONS, deps),
    deploymentNotes: [],
    importantDirectories: [],
  };
}

/**
 * Build a first-version project-knowledge snapshot (repository landscape) for one
 * or more repos. Repos with no readable package.json still get a minimal profile.
 */
export function buildProjectKnowledge(
  repos: RepoInput[],
  opts: BuildOptions = {},
): KnowledgeSnapshot {
  const now = opts.now ?? new Date().toISOString();
  const repositories = repos.map((r) => deriveRepositoryProfile(r, { ...opts, now }));
  return KnowledgeSnapshotSchema.parse({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: now,
    project: opts.project,
    repositories,
  });
}
