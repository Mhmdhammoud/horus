/**
 * HOR-74 — Local AI provider registry contract.
 *
 * Centralises provider IDs and typed shapes for local AI tools (Codex, Claude,
 * Kimi, Gemini, Cursor). No CLI execution, no token reading, no auth details
 * in the public contract. Implementations (detection, doctor) build on top.
 */

// ---------------------------------------------------------------------------
// Provider IDs
// ---------------------------------------------------------------------------

export type LocalProviderId = 'codex' | 'claude' | 'kimi' | 'gemini' | 'cursor';

export const LOCAL_PROVIDER_IDS: readonly LocalProviderId[] = [
  'codex',
  'claude',
  'kimi',
  'gemini',
  'cursor',
];

// ---------------------------------------------------------------------------
// Descriptor — what the registry stores per provider
// ---------------------------------------------------------------------------

export interface LocalProviderDescriptor {
  id: LocalProviderId;
  /** Human-readable display name for CLI output. */
  displayName: string;
}

// ---------------------------------------------------------------------------
// Detection / doctor result shapes
// ---------------------------------------------------------------------------

/** Coarse readiness state returned by a provider detector. */
export type LocalProviderStatus = 'ready' | 'installed' | 'unavailable';

/** Result shape for a single provider's detection/doctor check. */
export interface LocalProviderResult {
  id: LocalProviderId;
  status: LocalProviderStatus;
  /** Optional human-readable detail (e.g., "binary not found on PATH"). */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

export interface LocalProviderRegistry {
  /** All registered providers in insertion order. */
  readonly providers: ReadonlyArray<LocalProviderDescriptor>;
  /** Returns the descriptor for the given ID, or undefined if not registered. */
  get(id: LocalProviderId): LocalProviderDescriptor | undefined;
}

// ---------------------------------------------------------------------------
// Lookup result — discriminated union so callers handle missing providers
// ---------------------------------------------------------------------------

export type LocalProviderLookupResult =
  | { found: true; provider: LocalProviderDescriptor }
  | { found: false; id: string };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_DESCRIPTORS: LocalProviderDescriptor[] = [
  { id: 'codex', displayName: 'OpenAI Codex CLI' },
  { id: 'claude', displayName: 'Anthropic Claude' },
  { id: 'kimi', displayName: 'Moonshot Kimi' },
  { id: 'gemini', displayName: 'Google Gemini CLI' },
  { id: 'cursor', displayName: 'Cursor' },
];

/**
 * Build a LocalProviderRegistry from a list of descriptors.
 * Throws if two descriptors share the same ID.
 * Defaults to the five canonical providers when called without arguments.
 */
export function createLocalProviderRegistry(
  descriptors: LocalProviderDescriptor[] = DEFAULT_DESCRIPTORS,
): LocalProviderRegistry {
  const map = new Map<string, LocalProviderDescriptor>();
  const list: LocalProviderDescriptor[] = [];

  for (const d of descriptors) {
    if (map.has(d.id)) {
      throw new Error(`Duplicate provider ID: ${d.id}`);
    }
    map.set(d.id, d);
    list.push(d);
  }

  return {
    providers: list,
    get(id: LocalProviderId) {
      return map.get(id);
    },
  };
}

/**
 * Look up a provider by string ID.
 * Returns a discriminated result so callers cannot silently ignore a miss.
 */
export function lookupLocalProvider(
  registry: LocalProviderRegistry,
  id: string,
): LocalProviderLookupResult {
  const provider = registry.get(id as LocalProviderId);
  return provider ? { found: true, provider } : { found: false, id };
}

/** Singleton registry containing all five canonical local providers. */
export const DEFAULT_LOCAL_PROVIDER_REGISTRY: LocalProviderRegistry =
  createLocalProviderRegistry();
