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

export async function runAsk(
  id: string,
  directive: string,
  opts: { config?: string; json?: boolean },
): Promise<number> {
  const repoRoot = repoRootOrCwd();
  const cloudCfg = readCloudConfig(repoRoot);

  if (isCloudActive(cloudCfg)) {
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
      const report = await fetchInvestigationReportFromCloud(
        session.client,
        cloudCfg,
        id,
      );
      if (!report) {
        console.error(
          pc.red(
            `Cloud investigation ${id} has no saved report. Run this investigation with ${pc.bold('horus investigate')} first.`,
          ),
        );
        return 1;
      }
      return renderAnswer(report, directive, opts);
    } catch (err) {
      return reportCloudError(err);
    }
  }

  const { db, sql } = createDb(await resolveDbUrl(opts.config));
  try {
    const row = await getInvestigation(db, id);
    if (!row) {
      console.error(pc.red('No investigation found: ' + id));
      return 1;
    }
    if (!row.report) {
      console.error(pc.red('Investigation ' + id + ' has no stored report.'));
      return 1;
    }
    const report = migrateReport(row.report) as InvestigationReport;
    return renderAnswer(report, directive, opts);
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined;
    if (code === '22P02') {
      console.error(pc.red('No investigation found: ' + id));
      return 1;
    }
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    await sql.end();
  }
}
