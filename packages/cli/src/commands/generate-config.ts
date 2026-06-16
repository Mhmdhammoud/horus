/**
 * `horus generate-config` — write a starter horus.config.js that works with
 * the built binary. Users copy-paste the file from docs today; this command
 * creates it in one step with the right placeholders (HOR-90).
 *
 * HOR-191: when run inside an initialized Horus project (`.horus/config.json`
 * exists), the command is project-aware:
 *   - prefills the real project name and repo path
 *   - defaults to `horus.config.example.js` so it does not create a misleading
 *     active config next to the existing project config
 *   - explains the difference between `.horus/config.json` and `horus.config.js`
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pc from 'picocolors';
import { discoverLocalConfig, readLocalConfig } from '@horus/core';

function configTemplate(name: string, repoPath: string): string {
  return `\
export default {
  database: {
    url: process.env.DATABASE_URL ?? 'postgresql://horus:horus@localhost:5433/horus',
  },
  projects: [{
    name: '${name}',
    repositories: [{
      name: '${name}',
      path: '${repoPath}',
      source: { hostUrl: 'http://127.0.0.1:8420' },
    }],
    environments: [{
      name: 'production',
      readOnly: true,
      connectors: {
        // elasticsearch: { indexPattern: '${name}-prod-*' },
        // mongodb: { database: '${name}' },
        // grafana: {},
      },
    }],
  }],
};
`;
}

/** Best-effort extraction of project name and repo path from a local config file. */
function projectDefaults(localConfigPath: string): { name: string; repoPath: string } | null {
  try {
    const file = readLocalConfig(localConfigPath);
    const project = file.project as Record<string, unknown> | undefined;
    if (!project) return null;

    const name = typeof project.name === 'string' ? project.name : null;
    const repositories = Array.isArray(project.repositories) ? project.repositories : [];
    const firstRepo = repositories[0] as Record<string, unknown> | undefined;
    const repoPath = firstRepo && typeof firstRepo.path === 'string' ? firstRepo.path : null;

    if (name == null) return null;
    return { name, repoPath: repoPath ?? name };
  } catch {
    return null;
  }
}

export async function runGenerateConfig(opts: {
  out?: string;
  name?: string;
  repo?: string;
  force?: boolean;
  cwd?: string;
  write?: (line: string) => void;
}): Promise<number> {
  const log = opts.write ?? ((line: string) => console.log(line));
  const cwd = opts.cwd ?? process.cwd();

  const localConfigPath = discoverLocalConfig(cwd);
  const defaults = localConfigPath != null ? projectDefaults(localConfigPath) : null;
  const hasLocalConfig = defaults != null;

  // In an initialized project, default to a sample filename so we do not create
  // a misleading active config next to .horus/config.json. The user can still
  // override with --out.
  const defaultOut = hasLocalConfig ? 'horus.config.example.js' : 'horus.config.js';
  const outPath = resolve(cwd, opts.out ?? defaultOut);
  const name = opts.name ?? defaults?.name ?? 'my-project';
  const repoPath = opts.repo ?? defaults?.repoPath ?? `/path/to/${name}`;

  if (existsSync(outPath) && !opts.force) {
    log(`${pc.red('✗')} ${outPath} already exists`);
    log(pc.dim('  pass --force to overwrite'));
    return 1;
  }

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, configTemplate(name, repoPath), 'utf8');
  } catch (err) {
    log(`${pc.red('✗')} Could not write ${outPath}: ${(err as Error).message}`);
    return 1;
  }

  log(`${pc.green('✓')} Created ${outPath}`);
  log(pc.dim(`  project: ${name}`));
  log(pc.dim(`  repo:    ${repoPath}`));

  if (hasLocalConfig && localConfigPath != null) {
    log('');
    log(pc.yellow('Note:') + ` an initialized Horus project config exists at ${localConfigPath}`);
    log('  • .horus/config.json  — project config used by `horus investigate` from this repo');
    log('  • horus.config.js     — standalone/global config used with `horus doctor --config <path>`');
    log(pc.dim(`  next:  review ${outPath} and copy/adapt it as needed`));
  } else {
    log(pc.dim(`  next:    horus doctor --config ${outPath}`));
  }

  return 0;
}
