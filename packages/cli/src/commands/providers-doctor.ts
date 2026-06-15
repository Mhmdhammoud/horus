import pc from 'picocolors';
import {
  DEFAULT_LOCAL_PROVIDER_REGISTRY,
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

export function buildProviderResults(registry: LocalProviderRegistry): LocalProviderResult[] {
  return registry.providers.map((p) => ({
    id: p.id,
    status: 'unavailable' as const,
    detail: `install the ${p.displayName} binary to use this provider`,
  }));
}

export async function runProvidersDoctorCommand(opts?: {
  registry?: LocalProviderRegistry;
  write?: (line: string) => void;
}): Promise<number> {
  const registry = opts?.registry ?? DEFAULT_LOCAL_PROVIDER_REGISTRY;
  const write = opts?.write ?? ((line: string) => console.log(line));
  const results = buildProviderResults(registry);

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
  write(pc.dim('  Detection not yet implemented — install the provider binary first.'));
  write(pc.dim('  Cloud provider: ANTHROPIC_API_KEY=<key> horus investigate "hint" --ai'));
  write('');

  return 0;
}
