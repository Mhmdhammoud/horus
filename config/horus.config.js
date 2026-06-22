/**
 * Horus configuration (JavaScript — compatible with the curl-installed binary).
 *
 * This file is loaded by the built horus binary without requiring TypeScript
 * tooling. For source-mode use (tsx / ts-node), horus.config.ts is preferred
 * and provides editor types via defineConfig. Both files describe the same
 * project setup — keep them in sync.
 *
 * All connector secrets are read from environment variables at runtime (never
 * committed here). Default env-var names:
 *   ES_URL / ES_USERNAME / ES_PASSWORD
 *   GRAFANA_URL / GRAFANA_USER / GRAFANA_PASSWORD
 *   MONGODB_URL  (or a per-project urlEnv)
 *
 * Start an Axon source-intelligence host per repo:
 *   axon host --port <N>   (run inside, or pointed at, the indexed repo)
 */
export default {
  projects: [
    {
      name: 'leadcall-api',
      repositories: [
        {
          name: 'leadcall-api',
          path: '/Users/mhmdh/Documents/projects/meritt-dev/leadcall-api',
          axon: { hostUrl: 'http://127.0.0.1:8420' },
        },
      ],
      environments: [
        {
          name: 'production',
          readOnly: true,
          connectors: {
            elasticsearch: {
              indexPattern: 'leadcall-api-prod-*',
              serviceName: 'leadcall-api-prod',
            },
            mongodb: {
              urlEnv: 'LEADCALL_MONGODB_URL',
              database: 'leadcall_prod',
              collections: ['calls', 'tenants', 'devices', 'integrations'],
            },
            grafana: {},
          },
        },
      ],
    },
    {
      name: 'maison-safqa',
      repositories: [
        {
          name: 'maison-safqa',
          path: '/Users/mhmdh/Documents/projects/meritt-dev/maison-safqa',
          axon: { hostUrl: 'http://127.0.0.1:8421' },
        },
      ],
      environments: [
        {
          name: 'production',
          readOnly: true,
          connectors: {
            elasticsearch: {
              indexPattern: 'maison-safqa-*',
              serviceName: 'maison-safqa-prod',
            },
            mongodb: {
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
    pinnedVersion: '1.1.1',
  },

  database: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://horus:horus@localhost:5433/horus',
  },

  models: {
    reasoning: 'claude-opus-4-8',
    extraction: 'claude-haiku-4-5',
  },
};
