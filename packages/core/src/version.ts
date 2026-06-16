// Injected at build time from apps/horus/package.json via tsup define.
// Falls back to 'dev' in test environments where the define is not applied.
declare const __HORUS_VERSION__: string | undefined;
export const HORUS_VERSION: string = typeof __HORUS_VERSION__ !== 'undefined' ? __HORUS_VERSION__ : 'dev';

/**
 * The exact Axon version Horus is validated and pinned against. The Axon provider
 * asserts the running Axon matches this (see architecture.md §1, risk R4). A drifted
 * build must fail loudly rather than silently mis-map results.
 */
export const PINNED_AXON_VERSION = '1.0.5';

/** Horus-facing alias for PINNED_AXON_VERSION (HOR-136). */
export const PINNED_SOURCE_VERSION = PINNED_AXON_VERSION;
