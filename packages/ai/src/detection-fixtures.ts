/**
 * HOR-75 — Synthetic detection fixtures for local AI provider tests.
 *
 * All fixtures are offline and deterministic — no PATH probing, no CLI calls,
 * no dependency on the developer's machine. Use these in tests that need
 * pre-built LocalProviderResult values without running real detection logic.
 *
 * Three fixture sets, one per status:
 *   DETECTION_FIXTURES_READY       — binary found and working
 *   DETECTION_FIXTURES_INSTALLED   — binary found on PATH but not configured
 *   DETECTION_FIXTURES_UNAVAILABLE — binary not found on PATH
 */

import type { LocalProviderResult } from './local-providers.js';

// ---------------------------------------------------------------------------
// ready — binary present and authenticated / usable
// ---------------------------------------------------------------------------

export const DETECTION_FIXTURES_READY: Readonly<Record<string, LocalProviderResult>> = {
  codex: { id: 'codex', status: 'ready', detail: 'codex 1.0.0 — authenticated' },
  claude: { id: 'claude', status: 'ready', detail: 'claude 0.1.0 — authenticated' },
  kimi: { id: 'kimi', status: 'ready', detail: 'kimi 1.0.0 — authenticated' },
  gemini: { id: 'gemini', status: 'ready', detail: 'gemini 0.1.10 — authenticated' },
  cursor: { id: 'cursor', status: 'ready', detail: 'cursor 1.0.0 — authenticated' },
};

// ---------------------------------------------------------------------------
// installed — binary present on PATH but not yet configured / authenticated
// ---------------------------------------------------------------------------

export const DETECTION_FIXTURES_INSTALLED: Readonly<Record<string, LocalProviderResult>> = {
  codex: { id: 'codex', status: 'installed', detail: 'binary found on PATH but no active session' },
  claude: { id: 'claude', status: 'installed', detail: 'binary found on PATH but no active session' },
  kimi: { id: 'kimi', status: 'installed', detail: 'binary found on PATH but no active session' },
  gemini: { id: 'gemini', status: 'installed', detail: 'binary found on PATH but no active session' },
  cursor: { id: 'cursor', status: 'installed', detail: 'binary found on PATH but no active session' },
};

// ---------------------------------------------------------------------------
// unavailable — binary not found on PATH
// ---------------------------------------------------------------------------

export const DETECTION_FIXTURES_UNAVAILABLE: Readonly<Record<string, LocalProviderResult>> = {
  codex: { id: 'codex', status: 'unavailable', detail: 'codex: command not found' },
  claude: { id: 'claude', status: 'unavailable', detail: 'claude: command not found' },
  kimi: { id: 'kimi', status: 'unavailable', detail: 'kimi: command not found' },
  gemini: { id: 'gemini', status: 'unavailable', detail: 'gemini: command not found' },
  cursor: { id: 'cursor', status: 'unavailable', detail: 'cursor: command not found' },
};
