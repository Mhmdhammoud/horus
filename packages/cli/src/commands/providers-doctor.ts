import { spawnSync } from 'node:child_process';
import pc from 'picocolors';
import {
  DEFAULT_LOCAL_PROVIDER_REGISTRY,
  type LocalProviderId,
  type LocalProviderResult,
  type LocalProviderStatus,
  type LocalProviderRegistry,
} from '@horus/ai';

function statusMark(status: LocalProviderStatus): string {
  if (status === 'ready') return pc.green('✓');
  if (status === 'installed') return pc.yellow('~');
  return pc.red('✗');
}

function statusLabel(status: LocalProviderStatus): string {
  if (status === 'ready') return pc.green('ready');
  if (status === 'installed') return pc.yellow('installed (not configured)');
  return pc.dim('not found on PATH');
}

/** Probe a provider binary by attempting to run it with --version. */
function detectBinary(id: LocalProviderId): LocalProviderResult {
  const result = spawnSync(id, ['--version'], { stdio: 'pipe', timeout: 2000 });
  if (result.error) {
    return { id, status: 'unavailable', detail: `${id}: command not found` };
  }
  return { id, status: 'installed', detail: `${id}: found on PATH` };
}

export type DetectorFn = (id: LocalProviderId) => LocalProviderResult;

/**
 * Build a result list by running the detector against every provider in the
 * registry. Pass `_detect` to inject a fake detector in unit tests.
 */
export function buildProviderResults(
  registry: LocalProviderRegistry,
  _detect?: DetectorFn,
): LocalProviderResult[] {
  const detect = _detect ?? detectBinary;
  return registry.providers.map((p) => detect(p.id));
}

export async function runProvidersDoctorCommand(opts?: {
  registry?: LocalProviderRegistry;
  /** Injectable detector for tests — defaults to real PATH probing. */
  _detect?: DetectorFn;
  /** Injectable ANTHROPIC_API_KEY for tests — defaults to process.env. */
  _anthropicKey?: string | null;
  write?: (line: string) => void;
}): Promise<number> {
  const registry = opts?.registry ?? DEFAULT_LOCAL_PROVIDER_REGISTRY;
  const write = opts?.write ?? ((line: string) => console.log(line));
  const results = buildProviderResults(registry, opts?._detect);

  write(pc.bold('\nLocal AI providers\n'));
  for (const result of results) {
    const descriptor = registry.get(result.id);
    const name = descriptor?.displayName ?? result.id;
    write(
      `  ${statusMark(result.status)} ${result.id.padEnd(8)}  ${name.padEnd(22)}  ${statusLabel(result.status)}`,
    );
    if (result.status !== 'ready' && result.detail) {
      write(`    ${pc.dim('→ ' + result.detail)}`);
    }
  }
  write('');

  // Cloud provider: Anthropic API key detection
  write(pc.bold('Cloud AI providers\n'));
  const anthropicKey =
    opts?._anthropicKey !== undefined
      ? opts._anthropicKey
      : (process.env['ANTHROPIC_API_KEY'] ?? null);
  if (anthropicKey) {
    write(
      `  ${pc.green('✓')} ${'anthropic'.padEnd(8)}  ${'Anthropic Claude API'.padEnd(22)}  ${pc.green('ANTHROPIC_API_KEY configured')}`,
    );
  } else {
    write(
      `  ${pc.red('✗')} ${'anthropic'.padEnd(8)}  ${'Anthropic Claude API'.padEnd(22)}  ${pc.dim('ANTHROPIC_API_KEY not set')}`,
    );
    write(
      `    ${pc.dim('→ set ANTHROPIC_API_KEY=<key> to enable AI-powered investigation (horus investigate "hint" --ai)')}`,
    );
  }
  write('');

  return 0;
}
