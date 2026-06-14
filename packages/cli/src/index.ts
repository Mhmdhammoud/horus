import { Command } from 'commander';
import { HORUS_VERSION } from '@horus/core';
import { runStatus } from './commands/status.js';
import { runExplain } from './commands/explain.js';
import { runIndex } from './commands/index-repo.js';
import { runQueues } from './commands/queues.js';
import { runInvestigate } from './commands/investigate.js';
import { runChanges } from './commands/changes.js';
import { runTimeline } from './commands/timeline.js';
import { runWhatChanged } from './commands/what-changed.js';
import { runArchitecture } from './commands/architecture.js';
import { runBlastRadius } from './commands/blast-radius.js';
import { runRepos } from './commands/repos.js';
import { runSearch } from './commands/search.js';
import { runInvestigations } from './commands/investigations.js';
import { runReplay } from './commands/replay.js';

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
    .option('--repo <name>', 'repository name to scope the Axon lookup to')
    .option('--json', 'output JSON')
    .action(
      async (
        query: string,
        opts: { config?: string; depth?: number; repo?: string; json?: boolean },
      ) => {
        process.exitCode = await runExplain(query, {
          config: opts.config,
          depth: opts.depth,
          repo: opts.repo,
          json: opts.json,
        });
      },
    );

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

  program
    .command('investigate <hint>')
    .description('Run a deterministic investigation for an incident hint')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository to scope to')
    .option('--since <ref>', 'git ref/range for change-impact (e.g. HEAD~5)')
    .option('--json', 'output JSON (alias for --format json)')
    .option('--format <fmt>', 'output format: text | markdown | json', 'text')
    .action(
      async (
        hint: string,
        opts: {
          config?: string;
          repo?: string;
          since?: string;
          json?: boolean;
          format?: string;
        },
      ) => {
        process.exitCode = await runInvestigate(hint, {
          config: opts.config,
          repo: opts.repo,
          since: opts.since,
          json: opts.json,
          format: opts.format,
        });
      },
    );

  program
    .command('changes <base> [compare]')
    .description(
      'Show what changed between two git refs and which flows are affected (Axon change-impact)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--json', 'output JSON')
    .action(async (base: string, compare: string | undefined, opts: { config?: string; json?: boolean }) => {
      process.exitCode = await runChanges(base, compare, { config: opts.config, json: opts.json });
    });

  program
    .command('timeline [service]')
    .description(
      'Reconstruct what changed in a time window (git + change-impact) — evidence, not conclusions',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .option('--since <when>', 'git --since (e.g. "7 days ago", a date)')
    .option('--until <when>', 'git --until')
    .option('--json', 'output JSON')
    .action(
      async (
        service: string | undefined,
        opts: {
          config?: string;
          repo?: string;
          since?: string;
          until?: string;
          json?: boolean;
        },
      ) => {
        process.exitCode = await runTimeline(service, {
          config: opts.config,
          repo: opts.repo,
          since: opts.since,
          until: opts.until,
          json: opts.json,
        });
      },
    );

  program
    .command('what-changed [service]')
    .description(
      'Concise, evidence-backed summary of what changed for a service in a time window',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .option('--since <when>', 'git --since (default "7 days ago")')
    .option('--until <when>', 'git --until')
    .option('--json', 'output JSON')
    .action(
      async (
        service: string | undefined,
        opts: {
          config?: string;
          repo?: string;
          since?: string;
          until?: string;
          json?: boolean;
        },
      ) => {
        process.exitCode = await runWhatChanged(service, {
          config: opts.config,
          repo: opts.repo,
          since: opts.since,
          until: opts.until,
          json: opts.json,
        });
      },
    );

  program
    .command('architecture')
    .description(
      'Discover the living architecture (subsystems, async boundaries, external systems, fragility)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--json', 'output JSON')
    .action(async (opts: { config?: string; json?: boolean }) => {
      process.exitCode = await runArchitecture({ config: opts.config, json: opts.json });
    });

  program
    .command('blast-radius <query>')
    .description(
      'Failure-propagation analysis: upstream/downstream dependencies + blast radius across async boundaries',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-d, --depth <n>', 'traversal depth', (v) => parseInt(v, 10))
    .option('--json', 'output JSON')
    .action(
      async (query: string, opts: { config?: string; depth?: number; json?: boolean }) => {
        process.exitCode = await runBlastRadius(query, {
          config: opts.config,
          depth: opts.depth,
          json: opts.json,
        });
      },
    );

  program
    .command('repos')
    .description('List configured repositories and their Axon host health')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .action(async (opts: { config?: string }) => {
      process.exitCode = await runRepos({ config: opts.config });
    });

  program
    .command('search <query>')
    .description(
      'Search symbols across ALL configured repositories (you need not know which repo holds the answer)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-n, --limit <n>', 'results per repo', (v) => parseInt(v, 10))
    .option('--json', 'output JSON')
    .action(
      async (query: string, opts: { config?: string; limit?: number; json?: boolean }) => {
        process.exitCode = await runSearch(query, {
          config: opts.config,
          limit: opts.limit,
          json: opts.json,
        });
      },
    );

  program
    .command('investigations')
    .description('List recent investigations (ids for replay)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-n, --limit <n>', 'max rows', (v) => parseInt(v, 10))
    .action(async (opts: { config?: string; limit?: number }) => {
      process.exitCode = await runInvestigations({ config: opts.config, limit: opts.limit });
    });

  program
    .command('replay <id>')
    .description('Re-render a saved investigation from the audit store (no re-query)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--format <fmt>', 'text | markdown | json', 'text')
    .action(async (id: string, opts: { config?: string; format?: string }) => {
      process.exitCode = await runReplay(id, { config: opts.config, format: opts.format });
    });

  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
