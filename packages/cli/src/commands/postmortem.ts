import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createDb, getInvestigation } from '@horus/db';
import { generatePostmortem, migrateReport } from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { renderNarrative, AnthropicNarrativeProvider } from '@horus/ai';
import { buildNarrativeInput } from './investigate.js';

/**
 * HOR-26 — Draft an editable postmortem from a persisted investigation.
 * HOR-111 — adds --output <path> / --force for Markdown file export.
 * HOR-15  — adds --ai-summary to append an AI-generated summary section.
 * Read-only from Postgres; never touches the source-intelligence host or connectors.
 */
export async function runPostmortem(
  id: string,
  opts: {
    config?: string;
    output?: string;
    force?: boolean;
    write?: (line: string) => void;
    /** Bypass DB for unit tests — inject a pre-built report directly. */
    _report?: InvestigationReport;
    aiSummary?: boolean;
    aiModel?: string;
  },
): Promise<number> {
  const log = opts.write ?? ((line: string) => console.log(line));
  let sql: { end: () => Promise<void> } | undefined;
  try {
    let report: InvestigationReport;

    if (opts._report !== undefined) {
      report = opts._report;
    } else {
      const config = await loadConfig(opts.config);
      const conn = createDb(config.database.url);
      sql = conn.sql;
      const { db } = conn;
      const row = await getInvestigation(db, id);
      if (!row) {
        log(pc.red('No investigation found: ' + id));
        return 1;
      }
      if (!row.report) {
        log(pc.red('Investigation ' + id + ' has no stored report.'));
        return 1;
      }
      report = migrateReport(row.report) as InvestigationReport;
    }

    let content = generatePostmortem(report);

    if (opts.aiSummary) {
      const narrativeInput = buildNarrativeInput(report);
      const provider = new AnthropicNarrativeProvider({ model: opts.aiModel });
      const { output, fromProvider, validationErrors } = await renderNarrative(narrativeInput, { provider });

      if (!fromProvider) {
        content += `\n\n## AI Summary\n\n_AI summary unavailable: ${validationErrors?.[0] ?? 'provider error'}_\n`;
      } else {
        content += '\n\n## AI Summary\n\n';
        content += `**What happened:** ${output.what}\n\n`;
        content += `**Why:** ${output.why}\n`;
        if (output.whereNext.length > 0) {
          content += '\n**Next steps:**\n';
          for (const step of output.whereNext) {
            content += `- ${step}\n`;
          }
        }
        if (output.citations.length > 0) {
          content += `\n**Cited evidence:** ${output.citations.map((c) => c.evidenceId).join(', ')}\n`;
        }
      }
    }

    if (opts.output) {
      const outputPath = resolve(opts.output);
      if (existsSync(outputPath) && !opts.force) {
        log(pc.red('✗') + ' ' + outputPath + ' already exists');
        log(pc.dim('  pass --force to overwrite'));
        return 1;
      }
      try {
        writeFileSync(outputPath, content, 'utf8');
      } catch (err) {
        log(pc.red('✗ Could not write ' + outputPath + ': ') + (err as Error).message);
        return 1;
      }
      log(pc.green('✓') + ' Saved postmortem to ' + outputPath);
    } else {
      log(content);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(pc.red('postmortem failed: ' + message));
    return 1;
  } finally {
    if (sql) {
      await sql.end();
    }
  }
  return 0;
}
