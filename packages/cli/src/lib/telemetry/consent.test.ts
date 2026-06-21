import { describe, it, expect } from 'vitest';
import { resolveConsent, isCI } from './consent.js';
import { defaultTelemetryState, type TelemetryState } from './store.js';

/** Build a state with overridable tier flags (hermetic — never touches disk). */
function state(overrides?: {
  tierA?: boolean;
  tierB?: boolean;
  noticeShownAt?: string | null;
}): TelemetryState {
  const s = defaultTelemetryState('test-install-id');
  if (overrides?.tierA !== undefined) s.tierA.enabled = overrides.tierA;
  if (overrides?.tierB !== undefined) s.tierB.enabled = overrides.tierB;
  if (overrides?.noticeShownAt !== undefined) s.tierA.noticeShownAt = overrides.noticeShownAt;
  return s;
}

const env = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv;

describe('resolveConsent — defaults & saved state', () => {
  it('defaults to Tier A on, Tier B off when nothing is saved', () => {
    const d = resolveConsent({ env: env(), state: null });
    expect(d).toMatchObject({ tierA: true, tierB: false, forcedOff: false, source: 'default' });
  });

  it('honors a saved opt-out of Tier A', () => {
    const d = resolveConsent({ env: env(), state: state({ tierA: false }) });
    expect(d.tierA).toBe(false);
    expect(d.source).toBe('state');
  });

  it('honors a saved Tier B opt-in', () => {
    const d = resolveConsent({ env: env(), state: state({ tierA: true, tierB: true }) });
    expect(d).toMatchObject({ tierA: true, tierB: true });
  });
});

describe('resolveConsent — env hard opt-out (most restrictive wins)', () => {
  it('DO_NOT_TRACK forces everything off even with Tier A/B saved on', () => {
    const d = resolveConsent({ env: env({ DO_NOT_TRACK: '1' }), state: state({ tierA: true, tierB: true }) });
    expect(d).toMatchObject({ tierA: false, tierB: false, forcedOff: true, source: 'env' });
  });

  it('HORUS_TELEMETRY=0 forces off', () => {
    const d = resolveConsent({ env: env({ HORUS_TELEMETRY: '0' }), state: state({ tierA: true }) });
    expect(d).toMatchObject({ tierA: false, forcedOff: true, source: 'env' });
  });

  it('HORUS_TELEMETRY=off forces off', () => {
    expect(resolveConsent({ env: env({ HORUS_TELEMETRY: 'off' }) }).tierA).toBe(false);
  });

  it('DO_NOT_TRACK beats HORUS_TELEMETRY=1', () => {
    const d = resolveConsent({ env: env({ DO_NOT_TRACK: '1', HORUS_TELEMETRY: '1' }) });
    expect(d.forcedOff).toBe(true);
    expect(d.tierA).toBe(false);
  });

  it('DO_NOT_TRACK=0 is NOT an opt-out', () => {
    expect(resolveConsent({ env: env({ DO_NOT_TRACK: '0' }), state: null }).tierA).toBe(true);
  });
});

describe('resolveConsent — CI', () => {
  it('collects nothing in CI by default, even with Tier A saved on', () => {
    const d = resolveConsent({ env: env({ CI: 'true' }), state: state({ tierA: true }) });
    expect(d).toMatchObject({ tierA: false, tierB: false, forcedOff: false, source: 'ci' });
  });

  it('explicit HORUS_TELEMETRY=1 re-enables Tier A in CI', () => {
    const d = resolveConsent({ env: env({ CI: 'true', HORUS_TELEMETRY: '1' }), state: null });
    expect(d).toMatchObject({ tierA: true, source: 'env' });
  });

  it('DO_NOT_TRACK still wins inside CI', () => {
    const d = resolveConsent({ env: env({ CI: 'true', DO_NOT_TRACK: '1' }) });
    expect(d.forcedOff).toBe(true);
  });
});

describe('resolveConsent — explicit env enable', () => {
  it('HORUS_TELEMETRY=1 enables Tier A but not Tier B', () => {
    const d = resolveConsent({ env: env({ HORUS_TELEMETRY: 'true' }), state: state({ tierB: false }) });
    expect(d).toMatchObject({ tierA: true, tierB: false, source: 'env' });
  });

  it('env enable does not override a saved Tier B opt-in', () => {
    const d = resolveConsent({ env: env({ HORUS_TELEMETRY: '1' }), state: state({ tierB: true }) });
    expect(d.tierB).toBe(true);
  });
});

describe('isCI', () => {
  it('detects common CI providers', () => {
    expect(isCI(env({ GITHUB_ACTIONS: 'true' }))).toBe(true);
    expect(isCI(env({ GITLAB_CI: 'true' }))).toBe(true);
    expect(isCI(env({}))).toBe(false);
    expect(isCI(env({ CI: '' }))).toBe(false);
    expect(isCI(env({ CI: 'false' }))).toBe(false);
  });
});
