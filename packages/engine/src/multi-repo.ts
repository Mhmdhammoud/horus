/**
 * Multi-repository helpers (HOR-28).
 *
 * These utilities fan-out queries to every configured Axon host so the caller
 * never needs to know which repository holds the answer. Each per-provider call
 * is performed concurrently; failures are captured as `reachable: false` rather
 * than rejected outright, so one unreachable host does not abort the whole fan-out.
 */

import type { Symbol } from '@horus/core';
import type { RepoProvider } from '@horus/connectors';

export interface RepoSearchResult {
  repo: string;
  hostUrl: string;
  reachable: boolean;
  symbols: Symbol[];
}

export interface RepoHealth {
  repo: string;
  path: string;
  hostUrl: string;
  reachable: boolean;
  detail: string;
}

/**
 * Check the Axon host health for every configured repository concurrently.
 * A provider that throws is recorded as unreachable with the error message as
 * `detail`.
 */
export async function reposHealth(providers: RepoProvider[]): Promise<RepoHealth[]> {
  return Promise.all(
    providers.map(async (provider): Promise<RepoHealth> => {
      try {
        const h = await provider.code.health();
        return {
          repo: provider.name,
          path: provider.path,
          hostUrl: provider.hostUrl,
          reachable: h.ok,
          detail: h.detail,
        };
      } catch (err) {
        return {
          repo: provider.name,
          path: provider.path,
          hostUrl: provider.hostUrl,
          reachable: false,
          detail: (err as Error).message,
        };
      }
    }),
  );
}

/**
 * Search symbols across ALL configured repositories concurrently. Unreachable
 * hosts yield an empty `symbols` array and `reachable: false` rather than
 * throwing, so partial results are always returned.
 */
export async function searchAcrossRepos(
  query: string,
  providers: RepoProvider[],
  limit = 8,
): Promise<RepoSearchResult[]> {
  return Promise.all(
    providers.map(async (provider): Promise<RepoSearchResult> => {
      try {
        const h = await provider.code.health();
        const symbols = h.ok ? await provider.code.searchSymbols(query, limit) : [];
        return {
          repo: provider.name,
          hostUrl: provider.hostUrl,
          reachable: h.ok,
          symbols,
        };
      } catch (err) {
        void err; // per-provider error — degrade gracefully
        return {
          repo: provider.name,
          hostUrl: provider.hostUrl,
          reachable: false,
          symbols: [],
        };
      }
    }),
  );
}
