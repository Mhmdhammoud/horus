import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { horusConfigSchema, resolveEnvironment, listEnvironments } from './config.js';
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
