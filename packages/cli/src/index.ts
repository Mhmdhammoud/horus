import { Command, Option } from 'commander';
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
import { runOwner } from './commands/owner.js';
import { runPostmortem } from './commands/postmortem.js';
import { runScore, runScores } from './commands/score.js';
import { runAsk } from './commands/ask.js';
import { runOnboard } from './commands/onboard.js';
import { runSimulate } from './commands/simulate.js';
import { runLogs } from './commands/logs.js';
import { runMetrics } from './commands/metrics.js';
import { runState } from './commands/state.js';
import { runInit } from './commands/init.js';
import { runProjects } from './commands/projects.js';
import { runSetup } from './commands/setup.js';
import { runConnect } from './commands/connect.js';
import { runStop } from './commands/stop.js';
import { runHosts } from './commands/hosts.js';
import { runDoctor } from './commands/doctor.js';
import { runProvidersDoctorCommand } from './commands/providers-doctor.js';
import { runGenerateConfig } from './commands/generate-config.js';
import { runReadiness } from './commands/readiness.js';

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
    .version(`horus ${HORUS_VERSION}`, '-V, --version', 'output the version number');

  program
    .command('doctor')
    .description('Check local readiness: CLI version, git root, .horus config, and source-intelligence setup')
    .option('-c, --config <path>', 'path to horus.config.js for connector checks')
    .option('--json', 'output machine-readable JSON instead of human-readable text')
    .action(async (opts: { config?: string; json?: boolean }) => {
      process.exitCode = await runDoctor({ config: opts.config, json: opts.json });
    })
    .addHelpText('after', `
Examples:
  horus doctor
  horus doctor --json
  horus doctor --config ./horus.config.js
`);

  const providers = program
    .command('providers')
    .description('Local AI provider management');

  providers
    .command('doctor')
    .description('Check which local AI providers (Codex, Claude, Gemini, etc.) are available')
    .action(async () => {
      process.exitCode = await runProvidersDoctorCommand();
    });

  program
    .command('setup')
    .description('Verify prerequisites (source-intelligence backend + Postgres) and guide any fixes')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .action(async (opts: { config?: string }) => {
      process.exitCode = await runSetup(opts);
    });

  program
    .command('init')
    .description('Create a local .horus/config.json for this repo and register it')
    .option('--name <name>', 'project name (default: repo directory name)')
    .option('--env <name>', 'environment name (default: production)')
    .option('--source <url>', 'source-intelligence host URL for this repo (e.g. http://127.0.0.1:8420)')
    .addOption(new Option('--axon <url>', 'deprecated alias for --source').hideHelp())
    .option('--path <dir>', 'repository root (default: nearest git root, else cwd)')
    .action(
      async (opts: { name?: string; env?: string; source?: string; axon?: string; path?: string }) => {
        process.exitCode = await runInit({
          name: opts.name,
          env: opts.env,
          source: opts.source ?? opts.axon,
          path: opts.path,
        });
      },
    )
    .addHelpText('after', `
Examples:
  horus init
  horus init --name atlas-payments
  horus init --name atlas-payments --env staging
`);

  program
    .command('projects')
    .description('List projects registered in the global registry (~/.horus/registry.json)')
    .action(async () => {
      process.exitCode = await runProjects();
    });

  program
    .command('generate-config')
    .description('Create a starter horus.config.js with placeholders (HOR-90)')
    .option('--out <path>', 'output path (default: horus.config.js in cwd)')
    .option('--name <name>', 'project name placeholder (default: my-project)')
    .option('--repo <path>', 'repository path placeholder (default: /path/to/<name>)')
    .option('--force', 'overwrite an existing config file')
    .action(async (opts: { out?: string; name?: string; repo?: string; force?: boolean }) => {
      process.exitCode = await runGenerateConfig(opts);
    });

  program
    .command('readiness')
    .description('Summarize release/demo readiness: DB, source intelligence, connectors, and local config (HOR-97)')
    .option('-c, --config <path>', 'path to horus.config.js')
    .action(async (opts: { config?: string }) => {
      process.exitCode = await runReadiness({ config: opts.config });
    });

  program
    .command('connect <type>')
    .description(
      'Add or update a connector (elasticsearch / mongodb / grafana / redis / ai) in .horus/config.json',
    )
    .option('--env <name>', 'target environment (default: first environment in config)')
    .option('--provider <name>', 'AI provider for `connect ai` (anthropic / claude / codex / gemini)')
    .option('--api-key <key>', 'Anthropic API key for `connect ai`')
    .option('--model <id>', 'default model for `connect ai`')
    .option('--url <url>', 'connector URL or connection string (Redis with auth: redis://:password@host:6379)')
    .option('--username <user>', 'username (elasticsearch / grafana)')
    .option('--password <pass>', 'password (elasticsearch / grafana; for Redis embed in --url)')
    .option('--index-pattern <pattern>', 'Elasticsearch index pattern (required for elasticsearch)')
    .option('--service <name>', 'service name scope for log queries')
    .option('--database <name>', 'database name (required for mongodb)')
    .option('--collections <list>', 'comma-separated collection allowlist (mongodb)')
    .option('--dashboard <uid>', 'default dashboard uid (grafana)')
    .option(
      '--db <spec>',
      'redis logical DB as db:role1,role2 (e.g. 0:cache,state or 1:bullmq,queues); repeatable',
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option('--bullmq-prefix <prefix>', 'BullMQ key prefix for redis queue DBs (default: bull)')
    .option('--no-scan-dbs', 'skip interactive Redis DB scan')
    .option('--no-test', 'skip live connection probe')
    .action(
      async (
        type: string,
        opts: {
          env?: string;
          url?: string;
          username?: string;
          password?: string;
          indexPattern?: string;
          service?: string;
          database?: string;
          collections?: string;
          dashboard?: string;
          db?: string[];
          bullmqPrefix?: string;
          scanDbs?: boolean;
          provider?: string;
          apiKey?: string;
          model?: string;
          test?: boolean;
        },
      ) => {
        process.exitCode = await runConnect(type, {
          env: opts.env,
          url: opts.url,
          username: opts.username,
          password: opts.password,
          indexPattern: opts.indexPattern,
          service: opts.service,
          database: opts.database,
          collections: opts.collections,
          dashboard: opts.dashboard,
          db: opts.db,
          bullmqPrefix: opts.bullmqPrefix,
          scanDbs: opts.scanDbs,
          provider: opts.provider,
          apiKey: opts.apiKey,
          aiModel: opts.model,
          noTest: opts.test === false,
        });
      },
    );

  program
    .command('stop')
    .description('Stop the source-intelligence host for the current repo (or --all to stop every host)')
    .option('--all', 'stop all registered source-intelligence hosts')
    .action(async (opts: { all?: boolean }) => {
      process.exitCode = await runStop(opts);
    });

  program
    .command('hosts')
    .description('List registered source-intelligence hosts and their live status (port, repo, running/stopped)')
    .action(async () => {
      process.exitCode = await runHosts();
    });

  program
    .command('status')
    .description('Show config, provider health, and project/environment matrix')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name (show only this project)')
    .option('--env <name>', 'environment name (e.g. production)')
    .action(
      async (opts: { config?: string; name?: string; project?: string; env?: string }) => {
        const code = await runStatus(opts.config, {
          name: opts.name,
          project: opts.project,
          env: opts.env,
        });
        process.exitCode = code;
      },
    );

  program
    .command('explain <query>')
    .description(
      'Explain a symbol: location, community, callers/callees, impact, related flows',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-d, --depth <n>', 'impact depth', (v) => parseInt(v, 10))
    .option('--repo <name>', 'repository name to scope the source lookup to')
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
    .description('Build the queue map for a project (run the stitcher against its source-intelligence host)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name')
    .option('--env <name>', 'environment name (e.g. production)')
    .action(
      async (opts: { config?: string; name?: string; project?: string; env?: string }) => {
        process.exitCode = await runIndex(opts);
      },
    );

  program
    .command('queues [name]')
    .description('Show queue topology from source intelligence; --live adds real-time Redis/BullMQ state')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via registry)')
    .option('--project <name>', 'filter edges by project')
    .option('--live', 'fetch real-time queue depths and failed-job counts from Redis/BullMQ')
    .option('--json', 'output JSON')
    .action(
      async (
        name: string | undefined,
        opts: { config?: string; name?: string; project?: string; live?: boolean; json?: boolean },
      ) => {
        process.exitCode = await runQueues(name, {
          config: opts.config,
          name: opts.name,
          project: opts.project,
          live: opts.live,
          json: opts.json,
        });
      },
    );

  program
    .command('investigate <hint>')
    .description('Run a deterministic investigation for an incident hint')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name to scope to')
    .option('--env <name>', 'environment name (e.g. production)')
    .option('--repo <name>', 'repository/project to scope to (alias for --project)')
    .option('--since <ref>', 'git ref/range for change-impact (e.g. HEAD~5)')
    .option(
      '--service <name>',
      'service name to scope runtime logs, e.g. leadcall-api-prod',
    )
    .option('--json', 'output JSON (alias for --format json)')
    .option('--format <fmt>', 'output format: text | markdown | json', 'text')
    .option('--ai', 'enrich report with AI narrative (requires ANTHROPIC_API_KEY; falls back to deterministic on failure)')
    .option('--ai-model <model>', 'AI model for --ai (default: claude-opus-4-8)')
    .action(
      async (
        hint: string,
        opts: {
          config?: string;
          name?: string;
          project?: string;
          env?: string;
          repo?: string;
          since?: string;
          service?: string;
          json?: boolean;
          format?: string;
          ai?: boolean;
          aiModel?: string;
        },
      ) => {
        process.exitCode = await runInvestigate(hint, {
          config: opts.config,
          name: opts.name,
          project: opts.project,
          env: opts.env,
          repo: opts.repo,
          since: opts.since,
          service: opts.service,
          json: opts.json,
          format: opts.format,
          ai: opts.ai,
          aiModel: opts.aiModel,
        });
      },
    )
    .addHelpText('after', `
Examples:
  horus investigate "checkout latency spike"
  horus investigate --project atlas-payments --env production "checkout timeout"
  horus investigate --name atlas-payments "queue backlog"
  horus investigate --ai "payment failures"
`);

  program
    .command('changes <base> [compare]')
    .description(
      'Show what changed between two git refs and which flows are affected (source change-impact)',
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
    .option('--since <when>', 'git --since (default "7 days ago"; e.g. "30 days ago", a date)')
    .option('--until <when>', 'git --until')
    .option('--all', 'include all history instead of the default recent window')
    .option('--json', 'output JSON')
    .action(
      async (
        service: string | undefined,
        opts: {
          config?: string;
          repo?: string;
          since?: string;
          until?: string;
          all?: boolean;
          json?: boolean;
        },
      ) => {
        process.exitCode = await runTimeline(service, {
          config: opts.config,
          repo: opts.repo,
          since: opts.since,
          until: opts.until,
          all: opts.all,
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
    .description('List configured repositories and their source-intelligence host health')
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
    })
    .addHelpText('after', `
Examples:
  horus investigations
  horus investigations -n 20
`);

  program
    .command('replay <id>')
    .description('Re-render a saved investigation from the audit store (no re-query)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--format <fmt>', 'text | markdown | json', 'text')
    .option('--ai', 'enrich report with AI narrative (requires ANTHROPIC_API_KEY; falls back to deterministic on failure)')
    .option('--ai-model <model>', 'AI model for --ai (default: claude-opus-4-8)')
    .option('--refresh-ai', 're-run AI even if a stored judgment already exists')
    .action(async (id: string, opts: { config?: string; format?: string; ai?: boolean; aiModel?: string; refreshAi?: boolean }) => {
      process.exitCode = await runReplay(id, { config: opts.config, format: opts.format, ai: opts.ai, aiModel: opts.aiModel, refreshAi: opts.refreshAi });
    })
    .addHelpText('after', `
Examples:
  horus replay <id>
  horus replay <id> --format markdown
  horus replay <id> --format json
  horus replay <id> --ai
  horus replay <id> --ai --ai-model claude-sonnet-4-6
  horus replay <id> --ai --refresh-ai

  (Use 'horus investigations' to list saved investigation ids.)
`);

  program
    .command('postmortem <id>')
    .description('Draft an editable incident postmortem from a saved investigation')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--output <path>', 'write Markdown to a file instead of printing to stdout')
    .option('--force', 'overwrite the output file if it already exists')
    .option('--ai-summary', 'append an AI-generated summary section (requires ANTHROPIC_API_KEY; falls back gracefully)')
    .option('--ai-model <model>', 'AI model for --ai-summary (default: claude-opus-4-8)')
    .option('--refresh-ai', 're-run AI even if a stored judgment already exists')
    .action(async (id: string, opts: { config?: string; output?: string; force?: boolean; aiSummary?: boolean; aiModel?: string; refreshAi?: boolean }) => {
      process.exitCode = await runPostmortem(id, { config: opts.config, output: opts.output, force: opts.force, aiSummary: opts.aiSummary, aiModel: opts.aiModel, refreshAi: opts.refreshAi });
    })
    .addHelpText('after', `
Examples:
  horus postmortem <id>
  horus postmortem <id> --output ./postmortem.md
  horus postmortem <id> --output ./postmortem.md --force
  horus postmortem <id> --ai-summary
  horus postmortem <id> --output ./postmortem.md --ai-summary --ai-model claude-sonnet-4-6
  horus postmortem <id> --ai-summary --refresh-ai

  (Use 'horus investigations' to list saved investigation ids.)
`);

  program
    .command('owner <query>')
    .description(
      'Estimate who likely owns a component (git history, with confidence + evidence)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .option('--json', 'output JSON')
    .action(
      async (query: string, opts: { config?: string; repo?: string; json?: boolean }) => {
        process.exitCode = await runOwner(query, {
          config: opts.config,
          repo: opts.repo,
          json: opts.json,
        });
      },
    );

  program
    .command('score <id>')
    .description(
      'Score a saved investigation\'s quality (a feedback loop for Horus, not engineers)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--json', 'output JSON')
    .action(async (id: string, opts: { config?: string; json?: boolean }) => {
      process.exitCode = await runScore(id, { config: opts.config, json: opts.json });
    });

  program
    .command('ask <id> <directive>')
    .description(
      'Ask about or refine a saved investigation — reuses evidence, no re-query.\n' +
        '  Questions (direct answers):\n' +
        '    "what evidence contradicts <topic>?"  · "what evidence is missing?"\n' +
        '    "why is confidence not higher?"\n' +
        '  Topic filters (deterministic scoping):\n' +
        '    "focus on queue behavior" · "ignore deployment changes" · "retry"',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--json', 'output JSON')
    .action(async (id: string, directive: string, opts: { config?: string; json?: boolean }) => {
      process.exitCode = await runAsk(id, directive, { config: opts.config, json: opts.json });
    });

  program
    .command('scores')
    .description('List recent investigation quality scores + the average (trend)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-n, --limit <n>', 'max rows', (v) => parseInt(v, 10))
    .action(async (opts: { config?: string; limit?: number }) => {
      process.exitCode = await runScores({ config: opts.config, limit: opts.limit });
    });

  program
    .command('onboard [area]')
    .description(
      'Understand a system fast: architecture, critical paths, what breaks, ownership, past incidents',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .option('--json', 'output JSON')
    .action(async (area: string | undefined, opts: { config?: string; repo?: string; json?: boolean }) => {
      process.exitCode = await runOnboard(area, {
        config: opts.config,
        repo: opts.repo,
        json: opts.json,
      });
    });

  program
    .command('simulate [scenario]')
    .description(
      'Practice an incident: pick a synthetic scenario and compare your reasoning with Horus',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .action(async (scenario: string | undefined, opts: { config?: string; repo?: string }) => {
      process.exitCode = await runSimulate(scenario, {
        config: opts.config,
        repo: opts.repo,
      });
    });

  program
    .command('logs [service]')
    .description(
      'Synthesize error evidence from logs (signatures, first/last, affected services); --raw for lines',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name')
    .option('--env <name>', 'environment name (e.g. production)')
    .option('--since <when>', 'time window, e.g. 24h, 7d, or an ISO date')
    .option('--level <level>', 'minimum level (with --raw): trace|debug|info|warn|error|fatal')
    .option('--grep <text>', 'match text in the message')
    .option('--raw', 'dump individual log lines instead of synthesized evidence (error+ by default)')
    .option('--all-levels', 'with --raw: show all severity levels, not just error+')
    .option('--limit <n>', 'max records (with --raw)')
    .option('--json', 'output JSON')
    .action(
      async (
        service: string | undefined,
        opts: {
          config?: string;
          name?: string;
          project?: string;
          env?: string;
          since?: string;
          level?: string;
          grep?: string;
          raw?: boolean;
          allLevels?: boolean;
          limit?: string;
          json?: boolean;
        },
      ) => {
        process.exitCode = await runLogs(service, opts);
      },
    );

  program
    .command('state')
    .description(
      'Surface application-state evidence from MongoDB (read-only, allowlisted): counts, staleness, anomalous statuses',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name')
    .option('--env <name>', 'environment name (e.g. production)')
    .option('--stale-hours <n>', 'staleness threshold in hours (default 24)')
    .option('--json', 'output JSON')
    .action(
      async (opts: {
        config?: string;
        name?: string;
        project?: string;
        env?: string;
        staleHours?: string;
        json?: boolean;
      }) => {
        process.exitCode = await runState(opts);
      },
    );

  program
    .command('metrics [hint]')
    .description(
      'Grafana metrics evidence: find dashboards/panels for a hint and detect latency spikes, error-rate changes, throughput drops, queue growth',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--since <when>', 'window, e.g. 1h, 6h, 24h')
    .option('--step <secs>', 'range step seconds')
    .option('--dashboard <uid>', 'restrict to a dashboard uid')
    .option('--query <promql>', 'raw datasource query escape hatch')
    .option('--json', 'JSON output')
    .action(
      async (
        hint: string | undefined,
        opts: {
          config?: string;
          name?: string;
          since?: string;
          step?: string;
          dashboard?: string;
          query?: string;
          json?: boolean;
        },
      ) => {
        process.exitCode = await runMetrics(hint, opts);
      },
    );

  return program;
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
