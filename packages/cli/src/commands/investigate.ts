import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { codeForEnv, logsForEnv, mongoForEnv, queueForEnv, metricsForEnv } from '@horus/connectors';
import { createDb } from '@horus/db';
import { investigate, renderReport, reportToJSON, reportToMarkdown } from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { renderNarrative, AnthropicNarrativeProvider } from '@horus/ai';
import type { NarrativeInput } from '@horus/ai';
import type { Evidence } from '@horus/engine';

function extractEvidenceExcerpt(e: Evidence): string | undefined {
  if (!e.payload || typeof e.payload !== 'object') return undefined;
  const p = e.payload as Record<string, unknown>;
  const candidate =
    (typeof p['pattern'] === 'string' ? p['pattern'] : null) ??
    (typeof p['message'] === 'string' ? p['message'] : null) ??
    (typeof p['label'] === 'string' ? p['label'] : null) ??
    (typeof p['summary'] === 'string' ? p['summary'] : null) ??
    (typeof p['valueLabel'] === 'string' ? p['valueLabel'] : null);
  return candidate ? candidate.slice(0, 120) : undefined;
}

export function buildNarrativeInput(report: InvestigationReport): NarrativeInput {
  return {
    investigationId: report.id,
    hint: report.input.hint,
    reportConfidence: report.confidence,
    evidence: report.evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      excerpt: extractEvidenceExcerpt(e),
    })),
    knownServices: report.input.service ? [report.input.service] : [],
    suspectedCauses: report.suspectedCauses.map((c) => ({
      label: c.title,
      score: c.finalScore,
      evidenceIds: c.sourceEvidenceIds,
    })),
    deterministicSummary: report.summary,
    findings: report.findings.map((f) => ({
      title: f.title,
      evidenceIds: f.evidenceIds,
    })),
    hypotheses: report.hypotheses.map((h) => ({
      id: h.id,
      category: h.category,
      statement: h.statement,
      deterministicVerdict: h.verdict,
      deterministicConfidence: h.confidence,
      supportingEvidenceIds: h.supportingEvidenceIds,
    })),
  };
}

export async function runInvestigate(
  hint: string,
  opts: {
    config?: string;
    name?: string;
    project?: string;
    env?: string;
    /** @deprecated use project — kept for back-compat with parked commands */
    repo?: string;
    since?: string;
    service?: string;
    json?: boolean;
    format?: string;
    ai?: boolean;
    aiModel?: string;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config, { name: opts.name });

    // --repo is the legacy name; --project takes precedence when both are given.
    const projectName = opts.project ?? opts.repo;

    let renv;
    try {
      renv = resolveEnvironment(config, { project: projectName, env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const code = codeForEnv(renv);
    if (!code) {
      console.error(
        pc.red(
          `No source-intelligence connector configured for project "${renv.project}" / env "${renv.env}".`,
        ),
      );
      return 1;
    }

    const health = await code.health();
    if (!health.ok) {
      const sourceUrl = renv.repositories[0]?.sourceHostUrl ?? renv.repositories[0]?.axonHostUrl;
      console.error(
        pc.red(
          `Source-intelligence host unreachable for ${renv.project}/${renv.env}` +
            (sourceUrl ? ` (${sourceUrl}) — run: horus index` : ' — run: horus index'),
        ),
      );
      return 1;
    }

    const logs = logsForEnv(renv);
    const mongo = mongoForEnv(renv);
    const queue = queueForEnv(renv);
    const metrics = metricsForEnv(renv);

    // Resolve service name: CLI flag > connector default > undefined
    const service = opts.service ?? renv.connectors.elasticsearch?.serviceName;

    const { db, sql } = createDb(config.database.url);
    try {
      const report = await investigate(
        { hint, repo: renv.project, since: opts.since, service },
        {
          code,
          db,
          logs,
          mongo,
          queue,
          metrics,
          repoPath: renv.path,
          connectors: {
            elasticsearch: !!renv.connectors.elasticsearch?.url,
            grafana: !!renv.connectors.grafana?.url,
            mongodb: !!renv.connectors.mongodb?.url,
            redis: !!renv.connectors.redis?.url,
          },
        },
      );
      // --json is back-compat for --format json.
      const format = opts.json ? 'json' : (opts.format ?? 'text');
      const rendered =
        format === 'json'
          ? reportToJSON(report)
          : format === 'markdown' || format === 'md'
            ? reportToMarkdown(report)
            : renderReport(report);
      console.log(rendered);

      if (opts.ai && format !== 'json') {
        const narrativeInput = buildNarrativeInput(report);
        const provider = new AnthropicNarrativeProvider({ model: opts.aiModel });
        const { output, fromProvider, validationErrors } = await renderNarrative(narrativeInput, { provider });

        if (!fromProvider) {
          console.error(pc.yellow(`[ai] Provider unavailable — deterministic output shown above.`));
          if (validationErrors?.length) {
            console.error(pc.dim(`    ${validationErrors[0]}`));
          }
        } else {
          const sep = '─'.repeat(60);
          console.log(`\n${sep}`);
          console.log(pc.bold('AI Judgment') + pc.dim(` (confidence: ${(output.confidence * 100).toFixed(0)}%)`));
          console.log(sep);

          // Structured hypothesis judgments (HOR-197)
          if (output.hypothesisJudgments && output.hypothesisJudgments.length > 0) {
            console.log(pc.bold('Hypothesis verdicts:'));
            for (const j of output.hypothesisJudgments) {
              const verdictColor =
                j.verdict === 'supported' ? pc.green :
                j.verdict === 'weakened' ? pc.yellow :
                j.verdict === 'eliminated' ? pc.red : pc.dim;
              console.log(
                `  ${verdictColor(`[${j.verdict}]`)} ${j.category}` +
                pc.dim(` (${(j.confidence * 100).toFixed(0)}%)`),
              );
              console.log(pc.dim(`    ${j.rationale}`));
            }
            console.log('');
          }

          // Structured root cause assessment (HOR-197)
          if (output.rootCauseAssessment) {
            const rca = output.rootCauseAssessment;
            const uncertaintyColor =
              rca.uncertainty === 'low' ? pc.green :
              rca.uncertainty === 'medium' ? pc.yellow : pc.red;
            console.log(
              pc.bold('Root cause assessment:') +
              pc.dim(` uncertainty: ${uncertaintyColor(rca.uncertainty)}`),
            );
            console.log(rca.summary);
            if (rca.citedEvidenceIds.length > 0) {
              console.log(pc.dim(`  Cited: ${rca.citedEvidenceIds.join(', ')}`));
            }
            console.log('');
          }

          // Narrative sections
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
        }
      }
    } finally {
      await sql.end();
      if (mongo) await mongo.close();
      if (queue) await queue.close();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
