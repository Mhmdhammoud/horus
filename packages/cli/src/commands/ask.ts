import pc from 'picocolors';
import { createDb, getInvestigation } from '@horus/db';
import { resolveDbUrl } from '../lib/db-url.js';
import {
  refineInvestigation,
  renderRefined,
  refinedToJSON,
  answerQuestion,
  renderQAAnswer,
  qaToJSON,
  migrateReport,
} from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';
import { authedClient, repoRootOrCwd } from '../lib/cloud/session.js';
import { fetchInvestigationReportFromCloud } from '../lib/cloud/investigation-sync.js';
import { CloudError } from '../lib/cloud/api.js';
import { reportCloudError } from './context.js';

/**
 * HOR-21 / HOR-204 — ask: answer a follow-up question about a saved investigation,
 * or apply a deterministic topic-filter directive.
 *
 * Two modes, auto-detected from the input:
 *   - Q&A: "what evidence contradicts <topic>?", "what evidence is missing?",
 *     "why is confidence not higher?" → a direct answer from the saved report.
 *   - Topic filter (fallback): "queue", "retry", "ignore deployment" → a refined
 *     view scoped to that topic.
 *
 * Either way it reuses the persisted report's evidence — never re-queries Axon or
 * any production connector.
 */
function renderAnswer(
  report: InvestigationReport,
  directive: string,
  opts: { json?: boolean },
): number {
  const answer = answerQuestion(report, directive);
  if (answer) {
    console.log(opts.json ? qaToJSON(answer) : renderQAAnswer(answer));
    return 0;
  }

  const v = refineInvestigation(report, directive);
  console.log(opts.json ? refinedToJSON(report, v) : renderRefined(report, v));

  if (!opts.json && report.aiJudgment) {
    const j = report.aiJudgment;
    console.log('');
    console.log(pc.dim('─'.repeat(60)));
    console.log(pc.dim(`Stored AI judgment (${j.provider}, ${j.generatedAt}):`));
    if (j.rootCauseAssessment) {
      console.log(pc.bold('Root cause (AI):'), j.rootCauseAssessment.summary);
      console.log(pc.dim(`Uncertainty: ${j.rootCauseAssessment.uncertainty}`));
    } else {
      console.log(pc.bold('AI Why:'), j.why);
    }
  }
  return 0;
}

/** Classified result of a local-DB investigation lookup. */
type LocalLookup =
  | { kind: 'found'; report: InvestigationReport }
  | { kind: 'not-found' }
  | { kind: 'no-report' }
  | { kind: 'error'; message: string };

/**
 * Look up a locally-persisted investigation report by id. `engine.investigate()` always
 * persists the report to the local DB, and the id `investigate` prints as its header
 * (`# Investigation <id>`) is this local id — so the local store is the right first stop.
 */
async function lookupLocalInvestigation(id: string, configPath?: string): Promise<LocalLookup> {
  const { db, sql } = createDb(await resolveDbUrl(configPath));
  try {
    const row = await getInvestigation(db, id);
    if (!row) return { kind: 'not-found' };
    if (!row.report) return { kind: 'no-report' };
    return { kind: 'found', report: migrateReport(row.report) as InvestigationReport };
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined;
    // 22P02 = invalid uuid text → not a local id; let the caller try cloud / report not-found.
    if (code === '22P02') return { kind: 'not-found' };
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    await sql.end();
  }
}

export async function runAsk(
  id: string,
  directive: string,
  opts: { config?: string; json?: boolean },
): Promise<number> {
  const repoRoot = repoRootOrCwd();
  const cloudCfg = readCloudConfig(repoRoot);

  if (isCloudActive(cloudCfg)) {
    // HOR-319 (Bug 1): the id `investigate` prints as its header is the LOCAL id, while
    // the cloud API only knows its own investigation id. Resolve LOCAL first so the most
    // visible id works, then fall back to cloud (covers cloud-only / teammate runs).
    const local = await lookupLocalInvestigation(id, opts.config);
    if (local.kind === 'found') return renderAnswer(local.report, directive, opts);

    const session = authedClient();
    if (!session) {
      console.error(
        pc.red(
          `This repo is linked to Horus Cloud but you are not logged in. Run ${pc.bold('horus login')} first.`,
        ),
      );
      return 1;
    }
    try {
      const report = await fetchInvestigationReportFromCloud(session.client, cloudCfg, id);
      if (report) return renderAnswer(report, directive, opts);
      console.error(
        pc.red(
          `Investigation ${id} has no saved report locally or in Horus Cloud. Run ${pc.bold('horus investigate')} first.`,
        ),
      );
      return 1;
    } catch (err) {
      // A 404 here just means `id` isn't a cloud id either; since local also missed,
      // give a clear not-found instead of a raw cloud error.
      if (err instanceof CloudError && err.status === 404) {
        console.error(
          pc.red(
            `No investigation found for "${id}" locally or in Horus Cloud. Use the id printed at the top of \`horus investigate\` output.`,
          ),
        );
        return 1;
      }
      return reportCloudError(err);
    }
  }

  // Local mode — resolve against the local DB only.
  const local = await lookupLocalInvestigation(id, opts.config);
  switch (local.kind) {
    case 'found':
      return renderAnswer(local.report, directive, opts);
    case 'no-report':
      console.error(pc.red('Investigation ' + id + ' has no stored report.'));
      return 1;
    case 'error':
      console.error(pc.red(local.message));
      return 1;
    case 'not-found':
    default:
      console.error(pc.red('No investigation found: ' + id));
      return 1;
  }
}
