import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { horusConfigSchema, resolveEnvironment, listEnvironments, loadConfig } from './config.js';
import { PINNED_AXON_VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Fixtures — code (Axon) belongs to the project's repositories; runtime
// connectors belong to the environment.
// ---------------------------------------------------------------------------

const DB = { url: 'postgresql://horus:horus@localhost:5433/horus' };

const SINGLE_PROJECT_CONFIG = horusConfigSchema.parse({
  database: DB,
  projects: [
    {
      name: 'my-api',
      repositories: [
        { name: 'my-api', path: '/repos/my-api', axon: { hostUrl: 'http://127.0.0.1:8420' } },
      ],
      environments: [
        {
          name: 'production',
          connectors: {
            elasticsearch: { indexPattern: 'my-api-prod-*', serviceName: 'my-api-prod' },
            grafana: {},
          },
        },
      ],
    },
  ],
});

const TWO_PROJECT_CONFIG = horusConfigSchema.parse({
  database: DB,
  projects: [
    {
      name: 'api-a',
      repositories: [
        { name: 'api-a', path: '/repos/api-a', axon: { hostUrl: 'http://127.0.0.1:8420' } },
      ],
      environments: [{ name: 'production', connectors: {} }],
    },
    {
      name: 'api-b',
      repositories: [
        { name: 'api-b', path: '/repos/api-b', axon: { hostUrl: 'http://127.0.0.1:8421' } },
      ],
      environments: [{ name: 'production', connectors: {} }],
    },
  ],
});

const MULTI_ENV_CONFIG = horusConfigSchema.parse({
  database: DB,
  projects: [
    {
      name: 'my-svc',
      repositories: [
        { name: 'my-svc', path: '/repos/my-svc', axon: { hostUrl: 'http://127.0.0.1:8420' } },
      ],
      environments: [
        { name: 'staging', connectors: {} },
        { name: 'production', connectors: {} },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('horusConfigSchema', () => {
  it('applies defaults and requires a database url', () => {
    const parsed = horusConfigSchema.parse({ database: DB });
    expect(parsed.axon.pinnedVersion).toBe(PINNED_AXON_VERSION);
    expect(parsed.models.reasoning).toBe('claude-opus-4-8');
    expect(parsed.projects).toEqual([]);
  });

  it('rejects a config without a database url', () => {
    expect(() => horusConfigSchema.parse({})).toThrow();
  });

  it('rejects a repository with a non-url axon hostUrl', () => {
    expect(() =>
      horusConfigSchema.parse({
        database: DB,
        projects: [
          {
            name: 'x',
            repositories: [{ name: 'x', path: '/x', axon: { hostUrl: 'not-a-url' } }],
            environments: [{ name: 'prod', connectors: {} }],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects a project with no repositories', () => {
    expect(() =>
      horusConfigSchema.parse({
        database: DB,
        projects: [
          { name: 'x', repositories: [], environments: [{ name: 'prod', connectors: {} }] },
        ],
      }),
    ).toThrow();
  });

  it('rejects a project with no environments', () => {
    expect(() =>
      horusConfigSchema.parse({
        database: DB,
        projects: [
          { name: 'x', repositories: [{ name: 'x', path: '/x' }], environments: [] },
        ],
      }),
    ).toThrow();
  });

  it('defaults environment connectors to {}', () => {
    const parsed = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x' }],
          environments: [{ name: 'prod', connectors: {} }],
        },
      ],
    });
    const env = parsed.projects[0]?.environments[0];
    expect(env?.connectors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// listEnvironments
// ---------------------------------------------------------------------------

describe('listEnvironments', () => {
  it('returns empty array when no projects', () => {
    const cfg = horusConfigSchema.parse({ database: DB });
    expect(listEnvironments(cfg)).toEqual([]);
  });

  it('flattens projects × environments', () => {
    const list = listEnvironments(MULTI_ENV_CONFIG);
    expect(list).toEqual([
      { project: 'my-svc', env: 'staging' },
      { project: 'my-svc', env: 'production' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveEnvironment
// ---------------------------------------------------------------------------

describe('resolveEnvironment', () => {
  it('resolves the single project/env without any opts', () => {
    const renv = resolveEnvironment(SINGLE_PROJECT_CONFIG);
    expect(renv.project).toBe('my-api');
    expect(renv.env).toBe('production');
    expect(renv.path).toBe('/repos/my-api'); // primary repo path
    expect(renv.readOnly).toBe(true);
  });

  it('resolves the project repositories with their Axon hosts', () => {
    const renv = resolveEnvironment(SINGLE_PROJECT_CONFIG);
    expect(renv.repositories).toHaveLength(1);
    expect(renv.repositories[0]?.name).toBe('my-api');
    expect(renv.repositories[0]?.axonHostUrl).toBe('http://127.0.0.1:8420');
  });

  it('throws when project is unknown', () => {
    expect(() =>
      resolveEnvironment(TWO_PROJECT_CONFIG, { project: 'does-not-exist' }),
    ).toThrow(/Unknown project: does-not-exist/);
  });

  it('throws with a helpful list when multiple projects and no --project', () => {
    expect(() => resolveEnvironment(TWO_PROJECT_CONFIG)).toThrow(
      /Multiple projects configured/,
    );
  });

  it('selects the named project when --project is given', () => {
    const renv = resolveEnvironment(TWO_PROJECT_CONFIG, { project: 'api-b' });
    expect(renv.project).toBe('api-b');
    expect(renv.repositories[0]?.axonHostUrl).toBe('http://127.0.0.1:8421');
  });

  it('infers the project from the cwd repository when multiple projects + no --project', () => {
    // TWO_PROJECT_CONFIG has api-b at /repos/api-b
    expect(resolveEnvironment(TWO_PROJECT_CONFIG, { cwd: '/repos/api-b' }).project).toBe(
      'api-b',
    );
  });

  it('still throws when cwd matches no configured repository', () => {
    expect(() =>
      resolveEnvironment(TWO_PROJECT_CONFIG, { cwd: '/somewhere/unrelated' }),
    ).toThrow(/Multiple projects configured/);
  });

  it('defaults to the "production" env when multiple envs and no --env', () => {
    const renv = resolveEnvironment(MULTI_ENV_CONFIG);
    expect(renv.env).toBe('production');
  });

  it('keeps the same project-scoped Axon across environments', () => {
    // Code belongs to the project, so the repository's Axon is the same in any env.
    const staging = resolveEnvironment(MULTI_ENV_CONFIG, { env: 'staging' });
    const prod = resolveEnvironment(MULTI_ENV_CONFIG, { env: 'production' });
    expect(staging.env).toBe('staging');
    expect(staging.repositories[0]?.axonHostUrl).toBe('http://127.0.0.1:8420');
    expect(prod.repositories[0]?.axonHostUrl).toBe('http://127.0.0.1:8420');
  });

  it('throws when env is unknown', () => {
    expect(() =>
      resolveEnvironment(MULTI_ENV_CONFIG, { env: 'canary' }),
    ).toThrow(/Unknown environment: canary/);
  });

  describe('secret resolution from process.env', () => {
    const ORIG_ENV = { ...process.env };

    beforeEach(() => {
      process.env['ES_URL'] = 'http://es:9200';
      process.env['ES_USERNAME'] = 'elastic';
      process.env['ES_PASSWORD'] = 's3cr3t';
      process.env['GRAFANA_URL'] = 'http://grafana:3000';
      process.env['GRAFANA_USER'] = 'admin';
      process.env['GRAFANA_PASSWORD'] = 'grafana-pass';
    });

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in ORIG_ENV)) delete process.env[key];
        else process.env[key] = ORIG_ENV[key];
      }
    });

    it('reads elasticsearch creds from default env vars', () => {
      const renv = resolveEnvironment(SINGLE_PROJECT_CONFIG);
      expect(renv.connectors.elasticsearch?.url).toBe('http://es:9200');
      expect(renv.connectors.elasticsearch?.username).toBe('elastic');
      expect(renv.connectors.elasticsearch?.password).toBe('s3cr3t');
      expect(renv.connectors.elasticsearch?.indexPattern).toBe('my-api-prod-*');
      expect(renv.connectors.elasticsearch?.serviceName).toBe('my-api-prod');
    });

    it('reads grafana creds from default env vars', () => {
      const renv = resolveEnvironment(SINGLE_PROJECT_CONFIG);
      expect(renv.connectors.grafana?.url).toBe('http://grafana:3000');
      expect(renv.connectors.grafana?.username).toBe('admin');
      expect(renv.connectors.grafana?.password).toBe('grafana-pass');
    });
  });

  it('omits elasticsearch from resolved connectors when not configured', () => {
    const renv = resolveEnvironment(TWO_PROJECT_CONFIG, { project: 'api-a' });
    expect(renv.connectors.elasticsearch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HOR-47: elasticsearch preset and fields block
// ---------------------------------------------------------------------------

describe('horusConfigSchema — elasticsearch preset + fields (HOR-47)', () => {
  it('defaults preset to meritt', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', axon: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: { elasticsearch: { indexPattern: 'logs-*' } },
            },
          ],
        },
      ],
    });
    expect(cfg.projects[0]!.environments[0]!.connectors.elasticsearch!.preset).toBe('meritt');
  });

  it('accepts preset:ecs', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', axon: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: { indexPattern: 'logs-*', preset: 'ecs' },
              },
            },
          ],
        },
      ],
    });
    expect(cfg.projects[0]!.environments[0]!.connectors.elasticsearch!.preset).toBe('ecs');
  });

  it('rejects unknown preset values', () => {
    expect(() =>
      horusConfigSchema.parse({
        database: DB,
        projects: [
          {
            name: 'x',
            repositories: [{ name: 'x', path: '/x', axon: { hostUrl: 'http://localhost' } }],
            environments: [
              {
                name: 'production',
                connectors: {
                  elasticsearch: { indexPattern: 'logs-*', preset: 'logstash' },
                },
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts partial fields block and omits unset fields', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', axon: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: {
                  indexPattern: 'logs-*',
                  preset: 'meritt',
                  fields: { timestamp: '@timestamp', eventCode: 'error_code' },
                },
              },
            },
          ],
        },
      ],
    });
    const f = cfg.projects[0]!.environments[0]!.connectors.elasticsearch!.fields;
    expect(f?.timestamp).toBe('@timestamp');
    expect(f?.eventCode).toBe('error_code');
    expect(f?.level).toBeUndefined();
  });

  it('accepts a complete custom fields block', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', axon: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: {
                  indexPattern: 'logs-*',
                  preset: 'meritt',
                  fields: {
                    timestamp: 'ts',
                    level: 'severity',
                    levelFormat: 'string',
                    service: 'app_name',
                    serviceKeyword: false,
                    message: 'log_msg',
                    messageFallback: 'msg',
                    traceId: 'correlation_id',
                    requestId: 'req_id',
                    eventCode: 'error_code',
                    eventCodeKeyword: true,
                  },
                },
              },
            },
          ],
        },
      ],
    });
    const f = cfg.projects[0]!.environments[0]!.connectors.elasticsearch!.fields;
    expect(f?.timestamp).toBe('ts');
    expect(f?.levelFormat).toBe('string');
    expect(f?.serviceKeyword).toBe(false);
    expect(f?.eventCodeKeyword).toBe(true);
  });
});

describe('resolveEnvironment — elasticsearch fields forwarded (HOR-47)', () => {
  it('forwards preset and fields into resolved connector', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', axon: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: {
                  url: 'http://localhost:9200',
                  indexPattern: 'logs-*',
                  preset: 'ecs',
                  fields: { timestamp: '@timestamp', eventCode: 'event.code' },
                },
              },
            },
          ],
        },
      ],
    });
    const renv = resolveEnvironment(cfg);
    expect(renv.connectors.elasticsearch?.preset).toBe('ecs');
    expect(renv.connectors.elasticsearch?.fields?.timestamp).toBe('@timestamp');
    expect(renv.connectors.elasticsearch?.fields?.eventCode).toBe('event.code');
  });

  it('omits fields from resolved connector when not provided', () => {
    const cfg = horusConfigSchema.parse({
      database: DB,
      projects: [
        {
          name: 'x',
          repositories: [{ name: 'x', path: '/x', axon: { hostUrl: 'http://localhost' } }],
          environments: [
            {
              name: 'production',
              connectors: {
                elasticsearch: { url: 'http://localhost:9200', indexPattern: 'logs-*' },
              },
            },
          ],
        },
      ],
    });
    const renv = resolveEnvironment(cfg);
    expect(renv.connectors.elasticsearch?.fields).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HOR-83: native JS/ESM config loading (built binary path)
// ---------------------------------------------------------------------------

const MINIMAL_JS_CONFIG_CONTENT = `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [],
};
`;

const NO_DEFAULT_EXPORT_CONTENT = `export const notDefault = { database: { url: "x" } };
`;

describe('loadConfig — native JS/ESM loading (HOR-83)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `horus-config-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a .js config via native import() and returns a valid HorusConfig', async () => {
    const configPath = join(tmpDir, 'horus.config.js');
    writeFileSync(configPath, MINIMAL_JS_CONFIG_CONTENT);
    const cfg = await loadConfig(configPath);
    expect(cfg.database.url).toBe('postgresql://horus:horus@localhost:5433/horus');
    expect(cfg.projects).toEqual([]);
  });

  it('loads a .mjs config via native import()', async () => {
    const configPath = join(tmpDir, 'horus.config.mjs');
    writeFileSync(configPath, MINIMAL_JS_CONFIG_CONTENT);
    const cfg = await loadConfig(configPath);
    expect(cfg.database.url).toContain('postgresql://');
  });

  it('loads a .cjs config via native import()', async () => {
    const configPath = join(tmpDir, 'horus.config.cjs');
    writeFileSync(configPath, `module.exports = { database: { url: "postgresql://horus:horus@localhost:5433/horus" }, projects: [] };\n`);
    const cfg = await loadConfig(configPath);
    expect(cfg.database.url).toContain('postgresql://');
  });

  it('throws a clear error when .js config has no default export', async () => {
    const configPath = join(tmpDir, 'no-default.js');
    writeFileSync(configPath, NO_DEFAULT_EXPORT_CONTENT);
    await expect(loadConfig(configPath)).rejects.toThrow('must have a default export');
  });

  it('throws a clear error when .js config fails to load', async () => {
    const configPath = join(tmpDir, 'bad-syntax.js');
    writeFileSync(configPath, 'THIS IS NOT VALID JS !!!@@@');
    await expect(loadConfig(configPath)).rejects.toThrow(/Could not load Horus config/);
  });

  it('throws a readable validation error when .js config is structurally invalid', async () => {
    const configPath = join(tmpDir, 'invalid-schema.js');
    writeFileSync(configPath, `export default { notAValidKey: true };\n`);
    await expect(loadConfig(configPath)).rejects.toThrow(/Invalid Horus config/);
  });

  it('prefers config/horus.config.js over config/horus.config.ts when both exist', async () => {
    const configDir = join(tmpDir, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'horus.config.js'), MINIMAL_JS_CONFIG_CONTENT);
    // .ts file with a different DB url — if .ts were loaded, this URL would appear
    writeFileSync(
      join(configDir, 'horus.config.ts'),
      `export default { database: { url: "postgresql://should-not-be-loaded/db" }, projects: [] };\n`,
    );
    const cfg = await loadConfig(undefined, { cwd: tmpDir });
    // Should have loaded the .js file, not the .ts file
    expect(cfg.database.url).toBe('postgresql://horus:horus@localhost:5433/horus');
  });
});

// ---------------------------------------------------------------------------
// HOR-102: actionable config validation errors
// ---------------------------------------------------------------------------

describe('parseConfig — actionable validation errors (HOR-102)', () => {
  it('includes the config source path in the error', () => {
    expect(() => horusConfigSchema.parse({})).toThrow();
    // Verify via loadConfig that the source path appears in the message
  });

  it('missing database.url shows a postgresql example', () => {
    let caught: Error | null = null;
    try {
      horusConfigSchema.parse({ projects: [] });
    } catch (e) {
      caught = e as Error;
    }
    // Zod throws on missing database — the parseConfig wrapper adds the example hint
    // Here we test the schema rejects it; example hint is tested via loadConfig below
    expect(caught).not.toBeNull();
  });

  it('loadConfig shows database.url example in error for missing database', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default { projects: [] };\n`);
    try {
      let err: Error | null = null;
      try { await loadConfig(configPath); } catch (e) { err = e as Error; }
      expect(err).not.toBeNull();
      expect(err!.message).toContain('Invalid Horus config');
      expect(err!.message).toContain(configPath);
      expect(err!.message).toContain('postgresql://');
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('invalid axon hostUrl shows example URL with port hint', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "x",
    repositories: [{ name: "x", path: "/x", axon: { hostUrl: "not-a-url" } }],
    environments: [{ name: "prod", connectors: {} }],
  }],
};\n`);
    try {
      let err: Error | null = null;
      try { await loadConfig(configPath); } catch (e) { err = e as Error; }
      expect(err).not.toBeNull();
      expect(err!.message).toContain('hostUrl');
      expect(err!.message).toContain('8420');
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('empty repositories array shows example repository shape', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "x",
    repositories: [],
    environments: [{ name: "prod", connectors: {} }],
  }],
};\n`);
    try {
      let err: Error | null = null;
      try { await loadConfig(configPath); } catch (e) { err = e as Error; }
      expect(err).not.toBeNull();
      expect(err!.message).toContain('repositories');
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('throws with a readable "not found" error for an unknown config path', async () => {
    const err = await loadConfig('/tmp/horus-does-not-exist-xyz.js').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Could not load Horus config');
  });

  it('valid config continues to load without errors', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "valid-api",
    repositories: [{ name: "valid-api", path: "/repos/valid-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};\n`);
    try {
      const cfg = await loadConfig(configPath);
      expect(cfg.database.url).toContain('postgresql://');
      expect(cfg.projects[0]?.name).toBe('valid-api');
    } finally {
      rmSync(configPath, { force: true });
    }
  });

  it('invalid connector shape shows the field path in the error', async () => {
    const configPath = join(tmpdir(), `horus-valtest-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(configPath, `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "x",
    repositories: [{ name: "x", path: "/x" }],
    environments: [{
      name: "prod",
      connectors: { elasticsearch: { preset: "unknown-preset" } },
    }],
  }],
};\n`);
    try {
      let err: Error | null = null;
      try { await loadConfig(configPath); } catch (e) { err = e as Error; }
      expect(err).not.toBeNull();
      expect(err!.message).toContain('Invalid Horus config');
      expect(err!.message).toContain('elasticsearch');
    } finally {
      rmSync(configPath, { force: true });
    }
  });
});
