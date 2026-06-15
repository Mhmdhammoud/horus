/**
 * `horus generate-config` — write a starter horus.config.js that works with
 * the built binary. Users copy-paste the file from docs today; this command
 * creates it in one step with the right placeholders (HOR-90).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pc from 'picocolors';

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
  const outPath = resolve(cwd, opts.out ?? 'horus.config.js');
  const name = opts.name ?? 'my-project';
  const repoPath = opts.repo ?? `/path/to/${name}`;

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
  log(pc.dim(`  next:    horus doctor --config ${outPath}`));
  return 0;
}
