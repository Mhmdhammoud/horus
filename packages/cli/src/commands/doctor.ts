import pc from 'picocolors';
import {
  HORUS_VERSION,
  findRepoRoot,
  discoverLocalConfig,
  readLocalConfig,
} from '@horus/core';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  label: string;
  status: CheckStatus;
  detail: string;
  next?: string;
}

function mark(status: CheckStatus): string {
  if (status === 'pass') return pc.green('✓');
  if (status === 'warn') return pc.yellow('~');
  return pc.red('✗');
}

export async function runDoctor(opts?: { cwd?: string }): Promise<number> {
  const cwd = opts?.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  checks.push({
    label: 'CLI version',
    status: 'pass',
    detail: `horus ${HORUS_VERSION}`,
  });

  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    checks.push({ label: 'Git root', status: 'pass', detail: repoRoot });
  } else {
    checks.push({
      label: 'Git root',
      status: 'warn',
      detail: 'not in a git repository',
      next: 'run horus doctor from inside a git repository',
    });
  }

  const configPath = discoverLocalConfig(cwd);
  if (configPath) {
    checks.push({ label: 'Local config', status: 'pass', detail: configPath });

    try {
      const file = readLocalConfig(configPath);
      const project = file.project as Record<string, unknown>;
      const repos = project['repositories'] as Array<Record<string, unknown>> | undefined;
      const hasHost = repos?.some(
        (r) => (r['axon'] as Record<string, unknown> | undefined)?.['hostUrl'],
      );
      if (hasHost) {
        checks.push({ label: 'Source-intelligence host', status: 'pass', detail: 'configured' });
      } else {
        checks.push({
          label: 'Source-intelligence host',
          status: 'warn',
          detail: 'not configured',
          next: 'run `horus index` to analyze this repo and start a host, or pass --axon <url> to `horus init`',
        });
      }
    } catch {
      checks.push({
        label: 'Source-intelligence host',
        status: 'warn',
        detail: 'could not read local config',
        next: 'run `horus init` to recreate .horus/config.json for this repo',
      });
    }
  } else {
    checks.push({
      label: 'Local config',
      status: 'warn',
      detail: '.horus/config.json not found',
      next: 'run `horus init` to create one for this repo',
    });
    checks.push({
      label: 'Source-intelligence host',
      status: 'warn',
      detail: 'not configured (no local config)',
      next: 'run `horus init` then `horus index` to set up source intelligence',
    });
  }

  console.log(pc.bold('\nHorus readiness check\n'));
  let hasFailure = false;
  for (const check of checks) {
    console.log(`  ${mark(check.status)} ${pc.bold(check.label.padEnd(26))}  ${pc.dim(check.detail)}`);
    if (check.next) {
      console.log(`    ${pc.dim('→ ' + check.next)}`);
    }
    if (check.status === 'fail') hasFailure = true;
  }
  console.log('');

  return hasFailure ? 1 : 0;
}
