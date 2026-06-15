/**
 * HOR-77 — Local provider execution contract and mocked adapter.
 *
 * Defines the typed boundary for running a prompt through a local AI provider
 * command. No real binaries are invoked here — real adapters build on top of
 * this contract. The mocked adapter covers success, failure, timeout, and
 * unsupported modes for deterministic testing.
 */

import type { LocalProviderId } from './local-providers.js';

// ---------------------------------------------------------------------------
// Run input / output
// ---------------------------------------------------------------------------

export interface ProviderRunInput {
  providerId: LocalProviderId;
  /** The prompt to send to the provider. */
  prompt: string;
  /** Execution timeout in milliseconds. Defaults to 30 000 ms in real adapters. */
  timeoutMs?: number;
  /** Optional caller-supplied request ID for correlation. */
  requestId?: string;
}

export interface ProviderRunOutput {
  providerId: LocalProviderId;
  /** The provider's text response. */
  text: string;
  /** Wall-clock execution duration in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type ProviderRunErrorCode = 'unsupported' | 'timeout' | 'execution-failed';

export interface ProviderRunError {
  code: ProviderRunErrorCode;
  /** Human-readable message suitable for CLI output. */
  message: string;
  providerId: LocalProviderId;
}

// ---------------------------------------------------------------------------
// Result — discriminated union so callers must handle both branches
// ---------------------------------------------------------------------------

export type ProviderRunResult =
  | { ok: true; output: ProviderRunOutput }
  | { ok: false; error: ProviderRunError };

// ---------------------------------------------------------------------------
// Adapter interface — real adapters implement this
// ---------------------------------------------------------------------------

export interface ProviderExecutionAdapter {
  run(input: ProviderRunInput): Promise<ProviderRunResult>;
}

// ---------------------------------------------------------------------------
// Mocked adapter factory
// ---------------------------------------------------------------------------

export type MockProviderMode = 'success' | 'failure' | 'timeout' | 'unsupported';

/**
 * Build a deterministic adapter that returns a fixed result shape for the
 * given mode. Useful for unit tests and CLI stubs — no binaries are invoked.
 */
export function createMockedProviderAdapter(mode: MockProviderMode): ProviderExecutionAdapter {
  return {
    async run(input: ProviderRunInput): Promise<ProviderRunResult> {
      switch (mode) {
        case 'success':
          return {
            ok: true,
            output: {
              providerId: input.providerId,
              text: `[mock] response to: ${input.prompt.slice(0, 60)}`,
              durationMs: 42,
            },
          };

        case 'failure':
          return {
            ok: false,
            error: {
              code: 'execution-failed',
              message: `${input.providerId}: process exited with non-zero code (mock)`,
              providerId: input.providerId,
            },
          };

        case 'timeout':
          return {
            ok: false,
            error: {
              code: 'timeout',
              message: `${input.providerId}: timed out after ${input.timeoutMs ?? 30000}ms (mock)`,
              providerId: input.providerId,
            },
          };

        case 'unsupported':
          return {
            ok: false,
            error: {
              code: 'unsupported',
              message: `provider "${input.providerId}" is not supported by this adapter`,
              providerId: input.providerId,
            },
          };
      }
    },
  };
}
