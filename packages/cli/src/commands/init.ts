/**
 * `horus init` — write a local `.horus/config.json` for the repo and register it
 * (HOR-37, phase A). Code lives in the project's repositories; runtime connectors
 * are added to the environment afterwards. `horus index` does the same plus the
 * source-intelligence analyze/host lifecycle.
 */

import pc from 'picocolors';
import { basename, resolve } from 'node:path';
import {
  findRepoRoot,
  writeLocalConfig,
  registerProject,
  ensureProjectGitignore,
  type LocalConfigFile,
} from '@horus/core';

export async function runInit(opts: {
  name?: string;
  env?: string;
  source?: string;
  path?: string;
}): Promise<number> {
  try {
    const cwd = process.cwd();
    const root = opts.path ? resolve(opts.path) : (findRepoRoot(cwd) ?? cwd);
    const name = opts.name ?? basename(root);
    const envName = opts.env ?? 'production';

    const repo: Record<string, unknown> = { name, path: root };
    if (opts.source) repo['source'] = { hostUrl: opts.source };

    const file: LocalConfigFile = {
      version: 1,
      project: {
        name,
        repositories: [repo],
        environments: [{ name: envName, readOnly: true, connectors: {} }],
      },
    };

    const configPath = writeLocalConfig(root, file);
    registerProject(name, root, configPath);
    ensureProjectGitignore(root);

    console.log(`${pc.green('✓')} Initialized Horus project ${pc.bold(name)}`);
    console.log(pc.dim(`  config:     ${configPath}`));
    console.log(pc.dim(`  registered: horus investigate --name ${name} "<hint>"`));
    if (!opts.source) {
      console.log(
        pc.dim('  no source-intelligence host set — run `horus index` to analyze + host, or pass --source <url>'),
      );
    }
    console.log(
      pc.dim('  add runtime connectors (elasticsearch/mongodb/grafana) to .horus/config.json'),
    );
    console.log(
      pc.dim('  .horus/ is gitignored — local config and runtime state stay out of version control'),
    );
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
