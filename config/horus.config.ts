import { defineConfig } from '@horus/core';

/**
 * Horus configuration. See `horusConfigSchema` in @horus/core for the full shape.
 *
 * Transport note: Horus talks to Axon over HTTP/MCP only. Start a host with
 *   `axon host --port 8420`  (run inside, or pointed at, each indexed repo)
 * and set `axon.hostUrl` to it. No CLI shell-outs for queries.
 */
export default defineConfig({
  repos: [
    {
      name: 'leadcall-api',
      path: '/Users/mhmdh/Documents/projects/meritt-dev/leadcall-api',
      axonHostUrl: 'http://127.0.0.1:8420',
    },
    {
      name: 'maison-safqa',
      path: '/Users/mhmdh/Documents/projects/meritt-dev/maison-safqa',
      axonHostUrl: 'http://127.0.0.1:8421',
    },
  ],

  axon: {
    hostUrl: 'http://127.0.0.1:8420',
    pinnedVersion: '1.0.1',
  },

  // Plain Postgres (docker-compose maps it to localhost:5433). No pgvector in v0.
  database: {
    url: process.env.DATABASE_URL ?? 'postgresql://horus:horus@localhost:5433/horus',
  },

  models: {
    reasoning: 'claude-opus-4-8',
    extraction: 'claude-haiku-4-5',
  },

  providers: {
    elasticsearch: {
      url: process.env['ES_URL'],
      username: process.env['ES_USERNAME'],
      password: process.env['ES_PASSWORD'],
      indexPattern: process.env['ES_INDEX_PATTERN'] ?? 'leadcall-api-prod-*',
    },
    grafana: {
      url: process.env['GRAFANA_URL'],
      username: process.env['GRAFANA_USER'],
      password: process.env['GRAFANA_PASSWORD'],
    },
  },
});
