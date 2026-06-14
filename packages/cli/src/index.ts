import { Command } from 'commander';
import { HORUS_VERSION } from '@horus/core';
import { runStatus } from './commands/status.js';

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

  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
