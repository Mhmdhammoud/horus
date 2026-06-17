/**
 * HOR-208 — AxonCodeProvider.searchSymbols must resolve an exact symbol-name match
 * (e.g. `GaiaController`) ahead of fuzzy/semantic matches (e.g. `SchedulerController`).
 *
 * Root cause regression: the Phase-1 exact-match Cypher used `NOT n:File`, which Kùzu
 * rejects with a parser error. The throw was swallowed, so the exact phase produced
 * nothing and fuzzy search won. The fake client below throws on that bad syntax, so a
 * revert breaks these tests.
 */
import { describe, it, expect } from 'vitest';
import { AxonCodeProvider } from './provider.js';
import type { AxonHttpClient } from './client.js';

function fakeClient(): AxonHttpClient {
  return {
    async cypher(query: string) {
      // Simulate Kùzu rejecting the old label-negation predicate.
      if (/NOT\s+\w+:File/.test(query)) {
        throw new Error('Parser exception: Invalid input <... AND NOT n:File>');
      }
      // Exact-name lookup (Phase 1) → return the real declaration.
      if (/toLower\(n\.name\)\s*=\s*toLower/.test(query)) {
        return {
          columns: ['n.id', 'n.name', 'n.file_path'],
          rows: [
            ['class:src/controllers/gaia.controller.ts:GaiaController', 'GaiaController', 'src/controllers/gaia.controller.ts'],
          ],
          rowCount: 1,
        };
      }
      return { columns: [], rows: [], rowCount: 0 };
    },
    // Semantic search ranks the wrong, fuzzily-related controller first (the bug).
    async search() {
      return [
        {
          nodeId: 'class:src/controllers/scheduler.controller.ts:SchedulerController',
          score: 0.92,
          name: 'SchedulerController',
          filePath: 'src/controllers/scheduler.controller.ts',
          label: 'Class',
          snippet: '',
        },
      ];
    },
  } as unknown as AxonHttpClient;
}

describe('AxonCodeProvider.searchSymbols — exact-name wins (HOR-208)', () => {
  it('returns the exact declaration first, not the fuzzy match', async () => {
    const provider = new AxonCodeProvider(fakeClient());
    const results = await provider.searchSymbols('GaiaController', 5);
    expect(results[0]?.name).toBe('GaiaController');
    expect(results[0]?.filePath).toBe('src/controllers/gaia.controller.ts');
    // The fuzzy SchedulerController must NOT be first.
    expect(results[0]?.name).not.toBe('SchedulerController');
  });

  it('is case-insensitive on the exact match', async () => {
    const provider = new AxonCodeProvider(fakeClient());
    const results = await provider.searchSymbols('gaiacontroller', 5);
    expect(results[0]?.name).toBe('GaiaController');
  });
});
