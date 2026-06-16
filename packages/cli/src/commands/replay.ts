import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createDb, getInvestigation, updateInvestigationReport } from '@horus/db';
import { renderReport, reportToMarkdown, reportToJSON, migrateReport } from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { renderNarrative, AnthropicNarrativeProvider } from '@horus/ai';
import {
  buildNarrativeInput,
  renderStoredAIJudgment,
  narrativeOutputToStoredJudgment,
} from './investigate.js';

export async function runReplay(
  id: string,
  opts: {
    config?: string;
    format?: string;
    ai?: boolean;
    aiModel?: string;
    /** Re-run AI even if a stored judgment already exists. */
    refreshAi?: boolean;
  },
): Promise<number> {
  const config = await loadConfig(opts.config);
  const { db, sql } = createDb(config.database.url);
  try {
    const row = await getInvestigation(db, id);
    if (!row) {
      console.error(pc.red('No investigation found: ' + id));
      return 1;
    }
    if (!row.report) {
      console.error(
        pc.red(
          'Investigation ' +
            id +
            ' has no stored report (run a newer investigation).',
        ),
      );
      return 1;
    }
    const report = migrateReport(row.report) as InvestigationReport;
    const fmt = opts.format ?? 'text';
    const out =
      fmt === 'json'
        ? reportToJSON(report)
        : fmt === 'markdown' || fmt === 'md'
          ? reportToMarkdown(report)
          : renderReport(report);
    console.log(out);

    if (opts.ai && fmt !== 'json') {
      // Use stored judgment unless --refresh-ai is set (HOR-198)
      if (report.aiJudgment && !opts.refreshAi) {
        renderStoredAIJudgment(report.aiJudgment);
        console.log(pc.dim('[ai] Stored judgment replayed. Use --refresh-ai to regenerate.'));
      } else {
        const narrativeInput = buildNarrativeInput(report);
        const provider = new AnthropicNarrativeProvider({ model: opts.aiModel });
        const { output, fromProvider, validationErrors } = await renderNarrative(narrativeInput, { provider });

        if (!fromProvider) {
          console.error(pc.yellow('[ai] Provider unavailable — deterministic output shown above.'));
          if (validationErrors?.length) {
            console.error(pc.dim(`    ${validationErrors[0]}`));
          }
        } else {
          const stored = narrativeOutputToStoredJudgment(output, 'anthropic');
          report.aiJudgment = stored;
          try {
            await updateInvestigationReport(db, report.id, report);
          } catch {
            // best-effort
          }
          renderStoredAIJudgment(stored);
        }
      }
    }
  } finally {
    await sql.end();
  }
  return 0;
}
