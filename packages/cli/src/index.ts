import { Command } from 'commander';
import { HORUS_VERSION } from '@horus/core';
import { runStatus } from './commands/status.js';
import { runExplain } from './commands/explain.js';
import { runIndex } from './commands/index-repo.js';
import { runQueues } from './commands/queues.js';

/**
 * Build the Horus CLI program. Commands are added as their phases land:
 *   status (HOR-1) · index (STITCH) · explain/trace (HOR-3/4) ·
 *   investigate/ask/replay (HOR-5). See architecture.md §2.8.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('horus')
    .description('Local-first, source-aware production-incident investigation engine')
    .version(HORUS_VERSION);

  program
    .command('status')
    .description('Show config, provider health, and repo freshness')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .action(async (opts: { config?: string }) => {
      const code = await runStatus(opts.config);
      process.exitCode = code;
    });

  program
    .command('explain <query>')
    .description(
      'Explain a symbol: location, community, callers/callees, impact, related flows',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-d, --depth <n>', 'impact depth', (v) => parseInt(v, 10))
    .option('--json', 'output JSON')
    .action(async (query: string, opts: { config?: string; depth?: number; json?: boolean }) => {
      process.exitCode = await runExplain(query, {
        config: opts.config,
        depth: opts.depth,
        json: opts.json,
      });
    });

  program
    .command('index')
    .description('Build the queue map (run the stitcher against the Axon host)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .action(async (opts: { config?: string }) => {
      process.exitCode = await runIndex({ config: opts.config });
    });

  program
    .command('queues [name]')
    .description('Show producer -> queue -> worker edges')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .action(async (name: string | undefined, opts: { config?: string }) => {
      process.exitCode = await runQueues(name, { config: opts.config });
    });

  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
