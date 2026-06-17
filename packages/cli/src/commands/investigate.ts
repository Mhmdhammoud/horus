import pc from 'picocolors';
import { loadConfig, resolveEnvironment, resolveAiSettings } from '@horus/core';
import {
  codeForEnv,
  logsForEnv,
  mongoForEnv,
  queueForEnv,
  redisStateForEnv,
  metricsForEnv,
} from '@horus/connectors';
import { createDb, updateInvestigationReport } from '@horus/db';
import { investigate, renderReport, reportToJSON, reportToMarkdown } from '@horus/engine';
import type { InvestigationReport, StoredAIJudgment } from '@horus/engine';
import { renderNarrative, AnthropicNarrativeProvider } from '@horus/ai';
import type { NarrativeInput, NarrativeOutput, NarrativeProvider } from '@horus/ai';
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

/** Map a NarrativeOutput to the StoredAIJudgment shape for persistence. */
export function narrativeOutputToStoredJudgment(
  output: NarrativeOutput,
  provider: string,
): StoredAIJudgment {
  const judgment: StoredAIJudgment = {
    what: output.what,
    why: output.why,
    whereNext: output.whereNext,
    citations: output.citations,
    confidence: output.confidence,
    provider,
    generatedAt: new Date().toISOString(),
  };
  if (output.mentionedServices) judgment.mentionedServices = output.mentionedServices;
  if (output.hypothesisJudgments) judgment.hypothesisJudgments = output.hypothesisJudgments;
  if (output.rootCauseAssessment) judgment.rootCauseAssessment = output.rootCauseAssessment;
  return judgment;
}

/** Render a stored AI judgment to the console. */
export function renderStoredAIJudgment(
  judgment: StoredAIJudgment,
  write: (line: string) => void = (l) => console.log(l),
): void {
  const sep = '─'.repeat(60);
  write(`\n${sep}`);
  write(pc.bold('AI Judgment') + pc.dim(` (confidence: ${(judgment.confidence * 100).toFixed(0)}%, provider: ${judgment.provider})`));
  write(sep);

  if (judgment.hypothesisJudgments && judgment.hypothesisJudgments.length > 0) {
    write(pc.bold('Hypothesis verdicts:'));
    for (const j of judgment.hypothesisJudgments) {
      const verdictColor =
        j.verdict === 'supported' ? pc.green :
        j.verdict === 'weakened' ? pc.yellow :
        j.verdict === 'eliminated' ? pc.red : pc.dim;
      write(`  ${verdictColor(`[${j.verdict}]`)} ${j.category}` + pc.dim(` (${(j.confidence * 100).toFixed(0)}%)`));
      write(pc.dim(`    ${j.rationale}`));
    }
    write('');
  }

  if (judgment.rootCauseAssessment) {
    const rca = judgment.rootCauseAssessment;
    const uncertaintyColor =
      rca.uncertainty === 'low' ? pc.green :
      rca.uncertainty === 'medium' ? pc.yellow : pc.red;
    write(pc.bold('Root cause assessment:') + pc.dim(` uncertainty: ${uncertaintyColor(rca.uncertainty)}`));
    write(rca.summary);
    if (rca.citedEvidenceIds.length > 0) {
      write(pc.dim(`  Cited: ${rca.citedEvidenceIds.join(', ')}`));
    }
    write('');
  }

  write(pc.bold('What:') + ' ' + judgment.what);
  write(pc.bold('Why:') + ' ' + judgment.why);
  if (judgment.whereNext.length > 0) {
    write(pc.bold('Next steps:'));
    for (const step of judgment.whereNext) {
      write(`  • ${step}`);
    }
  }
  if (judgment.citations.length > 0) {
    write(pc.dim(`\nCited evidence: ${judgment.citations.map((c) => c.evidenceId).join(', ')}`));
  }
}

/**
 * Classify an AI provider failure reason into a user-readable string.
 * Inspects the first validationError to distinguish common failure modes.
 */
export function classifyAIFailure(firstError?: string): string {
  if (!firstError) return 'provider unavailable';
  if (/401|unauthorized|api.key|api key/i.test(firstError)) {
    return 'missing or invalid API key — set ANTHROPIC_API_KEY';
  }
  if (/invalid.request|model|not.found/i.test(firstError)) {
    return `invalid model or request — ${firstError}`;
  }
  if (/econnrefused|enotfound|network|fetch|abort/i.test(firstError)) {
    return 'network error — check connectivity';
  }
  return firstError;
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
    /** Injectable AI provider for smoke tests — bypasses credential requirement. */
    _aiProvider?: NarrativeProvider;
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
    const redisState = redisStateForEnv(renv);
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
          redisState,
          metrics,
          repoPath: renv.path,
          connectors: {
            elasticsearch: !!renv.connectors.elasticsearch?.url,
            grafana: !!renv.connectors.grafana?.url,
            mongodb: !!renv.connectors.mongodb?.url,
            redis: !!renv.connectors.redis?.url,
            // Queue runtime is configured iff a BullMQ provider was built (HOR-205).
            queue: !!queue,
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
        // Resolve AI settings saved via `horus connect ai` (key + model), with the
        // ANTHROPIC_API_KEY env as fallback. CLI --ai-model overrides the saved model.
        const ai = resolveAiSettings(config);
        const model = opts.aiModel ?? ai.model ?? 'claude-opus-4-8';
        const provider =
          opts._aiProvider ??
          new AnthropicNarrativeProvider({
            model,
            ...(ai.anthropicApiKey !== undefined ? { apiKey: ai.anthropicApiKey } : {}),
          });
        console.log(pc.dim(`[ai] model: ${model}`));

        const narrativeInput = buildNarrativeInput(report);
        const { output, fromProvider, degraded, validationErrors } = await renderNarrative(
          narrativeInput,
          { provider },
        );

        if (fromProvider) {
          // Persist AI judgment in the report and update DB (HOR-198)
          const stored = narrativeOutputToStoredJudgment(output, 'anthropic');
          report.aiJudgment = stored;
          try {
            await updateInvestigationReport(db, report.id, report);
          } catch {
            // best-effort — display still works even if DB update fails
          }
          renderStoredAIJudgment(stored);
        } else if (degraded) {
          // The model produced usable prose that didn't fully validate — show it in a
          // clearly-labeled unstructured section rather than discarding it (HOR-213).
          if (validationErrors && validationErrors.length > 0) {
            console.error(pc.yellow(`[ai] structured validation incomplete — showing raw AI narrative`));
          }
          console.log('');
          console.log(pc.dim('─'.repeat(60)));
          console.log(pc.bold('AI narrative ') + pc.yellow('(unstructured — not validated)'));
          if (output.what?.trim()) {
            console.log(pc.bold('\nWhat:'), output.what.trim());
          }
          if (output.why?.trim()) {
            console.log(pc.bold('\nWhy:'), output.why.trim());
          }
          if (output.whereNext.length > 0) {
            console.log(pc.bold('\nNext:'));
            for (const a of output.whereNext) console.log(`  - ${a}`);
          }
        } else {
          const reason = classifyAIFailure(validationErrors?.[0]);
          console.error(pc.yellow(`[ai] fallback to deterministic — ${reason}`));
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
