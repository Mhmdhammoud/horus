// Injected at build time from apps/horus/package.json via tsup define.
// Falls back to 'dev' in test environments where the define is not applied.
declare const __HORUS_VERSION__: string | undefined;
export const HORUS_VERSION: string = typeof __HORUS_VERSION__ !== 'undefined' ? __HORUS_VERSION__ : 'dev';

/**
 * The exact horus-source (source-intelligence) version Horus is validated and
 * pinned against. The source provider asserts the running host matches this
 * (see architecture.md §1, risk R4); a drifted build must fail loudly rather than
 * silently mis-map results.
 */
export const PINNED_SOURCE_VERSION = '1.1.1';

/** @deprecated Pre-rebrand name (Axon → horus-source). Use PINNED_SOURCE_VERSION. */
export const PINNED_AXON_VERSION = PINNED_SOURCE_VERSION;
