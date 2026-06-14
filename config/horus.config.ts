import { defineConfig } from '@horus/core';

/**
 * Horus configuration. See `horusConfigSchema` in @horus/core for the full shape.
 *
 * HOR-34: config is now project/environment scoped. All connector secrets are read
 * from environment variables at runtime (never committed here).
 *
 * Default env-var names used when *Env overrides are absent:
 *   ES_URL / ES_USERNAME / ES_PASSWORD
 *   GRAFANA_URL / GRAFANA_USER / GRAFANA_PASSWORD
 *   MONGODB_URL
 *
 * Transport note: Horus talks to Axon over HTTP/MCP only. Start a host with
 *   `axon host --port <N>`  (run inside, or pointed at, each indexed repo)
 * and set connectors.axon.hostUrl to it. No CLI shell-outs for queries.
 */
export default defineConfig({
  projects: [
    {
      name: 'leadcall-api',
      path: '/Users/mhmdh/Documents/projects/meritt-dev/leadcall-api',
      environments: [
        {
          name: 'production',
          readOnly: true,
          connectors: {
            axon: { hostUrl: 'http://127.0.0.1:8420' },
            elasticsearch: {
              indexPattern: 'leadcall-api-prod-*',
              serviceName: 'leadcall-api-prod',
              // urlEnv / usernameEnv / passwordEnv default to ES_URL / ES_USERNAME / ES_PASSWORD
            },
            mongodb: {
              // leadcall has its OWN Mongo cluster — a separate URL from maison's.
              // Set LEADCALL_MONGODB_URL to enable it; unset => "not configured" here.
              urlEnv: 'LEADCALL_MONGODB_URL',
              database: 'leadcall_prod',
              collections: ['calls', 'tenants', 'devices', 'integrations'],
            },
            grafana: {
              // urlEnv / usernameEnv / passwordEnv default to GRAFANA_URL / GRAFANA_USER / GRAFANA_PASSWORD
            },
          },
        },
      ],
    },
    {
      name: 'maison-safqa',
      path: '/Users/mhmdh/Documents/projects/meritt-dev/maison-safqa',
      environments: [
        {
          name: 'production',
          readOnly: true,
          connectors: {
            axon: { hostUrl: 'http://127.0.0.1:8421' },
            elasticsearch: {
              indexPattern: 'maison-safqa-*',
              serviceName: 'maison-safqa-prod',
            },
            mongodb: {
              // Uses the default MONGODB_URL (the maison cluster reachable here).
              database: 'maison-safqa',
              collections: [
                'gaiasynclogs',
                'gaiaproducts',
                'scheduleconfigs',
                'orders',
                'instas',
                'products',
                'brands',
                'suppliers',
                'users',
              ],
            },
            grafana: {
              dashboard: 'maison-safqa-technical-overview',
            },
          },
        },
      ],
    },
  ],

  axon: {
    pinnedVersion: '1.0.1',
  },

  // Plain Postgres (docker-compose maps it to localhost:5433). No pgvector in v0.
  database: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://horus:horus@localhost:5433/horus',
  },

  models: {
    reasoning: 'claude-opus-4-8',
    extraction: 'claude-haiku-4-5',
  },
});
