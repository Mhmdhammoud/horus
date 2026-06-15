import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createDb, getInvestigation } from '@horus/db';
import { renderReport, reportToMarkdown, reportToJSON, migrateReport } from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { renderNarrative, AnthropicNarrativeProvider } from '@horus/ai';
import { buildNarrativeInput } from './investigate.js';

export async function runReplay(
  id: string,
  opts: { config?: string; format?: string; ai?: boolean; aiModel?: string },
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
      const narrativeInput = buildNarrativeInput(report);
      const provider = new AnthropicNarrativeProvider({ model: opts.aiModel });
      const { output, fromProvider, validationErrors } = await renderNarrative(narrativeInput, { provider });

      if (!fromProvider) {
        console.error(pc.yellow('[ai] Provider unavailable — deterministic output shown above.'));
        if (validationErrors?.length) {
          console.error(pc.dim(`    ${validationErrors[0]}`));
        }
      } else {
        const sep = '─'.repeat(60);
        console.log(`\n${sep}`);
        console.log(pc.bold('AI Narrative'));
        console.log(sep);
        console.log(pc.bold('What:'), output.what);
        console.log(pc.bold('Why:'), output.why);
        if (output.whereNext.length > 0) {
          console.log(pc.bold('Next steps:'));
          for (const step of output.whereNext) {
            console.log(`  • ${step}`);
          }
        }
        if (output.citations.length > 0) {
          console.log(pc.dim(`\nCited evidence: ${output.citations.map((c) => c.evidenceId).join(', ')}`));
        }
        console.log(pc.dim(`AI confidence: ${(output.confidence * 100).toFixed(0)}%`));
      }
    }
  } finally {
    await sql.end();
  }
  return 0;
}
