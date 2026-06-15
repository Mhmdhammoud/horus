/**
 * HOR-113 — Reusable fake NarrativeProvider for deterministic testing.
 *
 * Use `createFakeNarrativeProvider` to wrap any pre-built NarrativeOutput into
 * a NarrativeProvider that satisfies the contract without making any network
 * calls. Safe in CI with no API credentials.
 */

import type { NarrativeInput, NarrativeOutput, NarrativeProvider } from './contract.js';
import { FIXTURE_VALID_OUTPUT } from './fixtures.js';

/**
 * Build a deterministic NarrativeProvider that always returns the given output.
 * Defaults to `FIXTURE_VALID_OUTPUT` when no output is supplied so the provider
 * is immediately usable in simple smoke tests.
 *
 * The output is returned as-is — validation is intentionally left to
 * `renderNarrative` / `validateNarrative` so tests can exercise both the
 * success and validation-failure paths.
 */
export function createFakeNarrativeProvider(
  output: NarrativeOutput = FIXTURE_VALID_OUTPUT,
): NarrativeProvider {
  return {
    name: 'fake',
    async render(_input: NarrativeInput): Promise<NarrativeOutput> {
      return output;
    },
  };
}
