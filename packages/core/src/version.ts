/** Horus release version. */
export const HORUS_VERSION = '0.1.0';

/**
 * The exact Axon version Horus is validated and pinned against. The Axon provider
 * asserts the running Axon matches this (see architecture.md §1, risk R4). A drifted
 * build must fail loudly rather than silently mis-map results.
 */
export const PINNED_AXON_VERSION = '1.0.1';
