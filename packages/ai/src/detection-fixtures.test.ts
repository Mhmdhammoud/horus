import { describe, it, expect } from 'vitest';
import {
  DETECTION_FIXTURES_READY,
  DETECTION_FIXTURES_INSTALLED,
  DETECTION_FIXTURES_UNAVAILABLE,
} from './detection-fixtures.js';
import { LOCAL_PROVIDER_IDS } from './local-providers.js';

const FIXTURE_SETS = [
  { name: 'DETECTION_FIXTURES_READY', fixtures: DETECTION_FIXTURES_READY, expectedStatus: 'ready' },
  {
    name: 'DETECTION_FIXTURES_INSTALLED',
    fixtures: DETECTION_FIXTURES_INSTALLED,
    expectedStatus: 'installed',
  },
  {
    name: 'DETECTION_FIXTURES_UNAVAILABLE',
    fixtures: DETECTION_FIXTURES_UNAVAILABLE,
    expectedStatus: 'unavailable',
  },
] as const;

for (const { name, fixtures, expectedStatus } of FIXTURE_SETS) {
  describe(name, () => {
    it('covers all 5 canonical provider IDs', () => {
      const keys = Object.keys(fixtures);
      expect(keys).toHaveLength(LOCAL_PROVIDER_IDS.length);
      for (const id of LOCAL_PROVIDER_IDS) {
        expect(keys).toContain(id);
      }
    });

    it(`all entries carry status "${expectedStatus}"`, () => {
      for (const result of Object.values(fixtures)) {
        expect(result.status).toBe(expectedStatus);
      }
    });

    it('id field matches the map key for each entry', () => {
      for (const [key, result] of Object.entries(fixtures)) {
        expect(result.id).toBe(key);
      }
    });

    it('all entries include a non-empty detail string', () => {
      for (const result of Object.values(fixtures)) {
        expect(result.detail).toBeTruthy();
        expect(typeof result.detail).toBe('string');
      }
    });

    it('no real PATH probing — detail strings are static synthetic text', () => {
      for (const result of Object.values(fixtures)) {
        expect(result.detail).not.toMatch(/^\s*$/);
      }
    });
  });
}

describe('detection fixture cross-set consistency', () => {
  it('each provider ID appears in all three fixture sets', () => {
    for (const id of LOCAL_PROVIDER_IDS) {
      expect(DETECTION_FIXTURES_READY).toHaveProperty(id);
      expect(DETECTION_FIXTURES_INSTALLED).toHaveProperty(id);
      expect(DETECTION_FIXTURES_UNAVAILABLE).toHaveProperty(id);
    }
  });

  it('each provider has three distinct statuses across the fixture sets', () => {
    for (const id of LOCAL_PROVIDER_IDS) {
      const statuses = new Set([
        DETECTION_FIXTURES_READY[id]?.status,
        DETECTION_FIXTURES_INSTALLED[id]?.status,
        DETECTION_FIXTURES_UNAVAILABLE[id]?.status,
      ]);
      expect(statuses.size).toBe(3);
    }
  });

  it('ready and installed details differ (installed is not already authenticated)', () => {
    for (const id of LOCAL_PROVIDER_IDS) {
      const ready = DETECTION_FIXTURES_READY[id]?.detail ?? '';
      const installed = DETECTION_FIXTURES_INSTALLED[id]?.detail ?? '';
      expect(ready).not.toBe(installed);
    }
  });
});
