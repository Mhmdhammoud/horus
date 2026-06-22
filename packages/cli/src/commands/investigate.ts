import pc from 'picocolors';
import { loadConfig, resolveEnvironment, resolveAiSettings, redactContent, redactOrDrop } from '@horus/core';
import {
  codeForEnv,
  logsForEnv,
  mongoForEnv,
  postgresForEnv,
  sentryForEnv,
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
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';
import { authedClient, repoRootOrCwd } from '../lib/cloud/session.js';
import { uploadInvestigationToCloud } from '../lib/cloud/investigation-sync.js';
import { track } from '../lib/telemetry/client.js';
import { isContentSharingEnabled } from '../lib/telemetry/consent.js';
import { maybePromptFeedback } from '../lib/telemetry/feedback.js';
import { ensureSourceHost, ensureHostReasonHint } from '../lib/ensure-host.js';
import { reportCloudError } from './context.js';

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

/**
 * Resolve `p`, or reject after `ms` with a clear, actionable message. The underlying work is
 * left to be torn down by process exit — this exists so a hung connector (e.g. a dropped
 * tunnel/port-forward, or a stuck source-intelligence query) can never hang the CLI forever.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Investigation exceeded ${Math.round(ms / 1000)}s and was aborted. A runtime connector ` +
            `is likely unreachable (e.g. a dropped SSH tunnel / port-forward) or the source-` +
            `intelligence host is slow. Re-run, or raise --timeout <seconds>.`,
        ),
      );
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
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
    /** Widen the runtime-log window independently of `--since` (a duration like 30d/24h). */
    logsSince?: string;
    /** Overall investigation deadline in seconds (default 120). */
    timeout?: string;
    service?: string;
    json?: boolean;
    format?: string;
    ai?: boolean;
    aiModel?: string;
    /** Injectable AI provider for smoke tests — bypasses credential requirement. */
    _aiProvider?: NarrativeProvider;
  },
): Promise<number> {
  const startedAtMs = Date.now();
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

    const repoRoot = repoRootOrCwd(renv.path);
    const cloudCfg = readCloudConfig(repoRoot);
    const cloudActive = isCloudActive(cloudCfg);
    const cloudSession = cloudActive ? authedClient() : null;
    if (cloudActive && !cloudSession) {
      // Horus Cloud is OPTIONAL — never block a local investigation on it. Warn and
      // proceed locally; the cloud upload at the end is simply skipped when there is
      // no session (see the `cloudSession` guard before uploadInvestigationToCloud).
      console.error(
        pc.yellow(
          `This repo is linked to Horus Cloud but you are not logged in — running locally only. ` +
            `Run ${pc.bold('horus login')} to also sync results to the cloud.`,
        ),
      );
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

    const sourceUrl = renv.repositories[0]?.sourceHostUrl;
    let health = await code.health();
    if (!health.ok && sourceUrl) {
      // HOR-319 (Bug 2 / layer-1): don't hard-exit just because the host is down. Try to
      // restart a previously-indexed host at its configured port, then re-check.
      console.error(
        pc.yellow(`Source-intelligence host unreachable (${sourceUrl}) — attempting to start it…`),
      );
      const healed = await ensureSourceHost(renv.path, sourceUrl);
      if (healed.ok) {
        console.error(pc.green(`Source-intelligence host is up at ${healed.hostUrl}.`));
        health = await code.health();
      } else {
        console.error(pc.dim(`  ${ensureHostReasonHint(healed.reason)}`));
      }
    }

    // HOR-319 (layer-2): if self-heal failed, DON'T dead-end. Degrade to a runtime-only
    // investigation — logs/metrics/state/queues are independent of the source host. The
    // engine runs without source intelligence and caps confidence accordingly.
    const runtimeOnly = !health.ok;
    if (runtimeOnly) {
      console.error(
        pc.yellow(
          `Proceeding in runtime-only mode — no source intelligence. ` +
            `Run ${pc.bold('horus index')} for a full (code-aware) investigation.`,
        ),
      );
    }

    const logs = logsForEnv(renv);
    const mongo = mongoForEnv(renv);
    const postgres = postgresForEnv(renv);
    const sentry = sentryForEnv(renv);
    const queue = queueForEnv(renv);
    const redisState = redisStateForEnv(renv);
    const metrics = metricsForEnv(renv);

    // Resolve service name: CLI flag > connector default > undefined
    const service = opts.service ?? renv.connectors.elasticsearch?.serviceName;

    const { db, sql } = createDb(config.database.url);
    try {
      const investigation = investigate(
        { hint, repo: renv.project, since: opts.since, logsSince: opts.logsSince, service },
        {
          // Runtime-only degrade (HOR-319 layer-2): pass no source provider so the engine
          // skips seed resolution + structural evidence and builds from runtime evidence.
          code: runtimeOnly ? null : code,
          db,
          logs,
          mongo,
          postgres,
          sentry,
          queue,
          redisState,
          metrics,
          repoPath: renv.path,
          connectors: {
            elasticsearch: !!renv.connectors.elasticsearch?.url,
            grafana: !!renv.connectors.grafana?.url,
            mongodb: !!renv.connectors.mongodb?.url,
            postgres: !!renv.connectors.postgres?.url,
            sentry: !!renv.connectors.sentry,
            redis: !!renv.connectors.redis?.url,
            // Queue runtime is configured iff a BullMQ provider was built (HOR-205).
            queue: !!queue,
          },
        },
      );
      // Overall deadline so an unreachable/slow connector (e.g. a dropped tunnel or a stuck
      // source-intelligence query) can never hang the investigation forever (HOR — reliability).
      const timeoutSec =
        (opts.timeout !== undefined ? Number(opts.timeout) : 0) ||
        Number(process.env.HORUS_INVESTIGATE_TIMEOUT_S) ||
        120;
      const report = await withDeadline(investigation, timeoutSec * 1000);
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

      // Tier-A usage signal: shape + confidence + gaps only, no report bodies (HOR-324).
      track({
        type: 'investigation.completed',
        investigationId: report.id,
        confidence: typeof report.confidence === 'number' ? report.confidence : null,
        evidenceCount: report.evidence?.length ?? 0,
        findingCount: report.findings?.length ?? 0,
        suspectedCauseCount: report.suspectedCauses?.length ?? 0,
        degraded: Boolean(report.degraded),
        gapCount: report.gapAnalysis?.gaps?.length ?? 0,
        hasAi: Boolean(report.aiJudgment),
      });

      // Tier-B (explicit content opt-in): redacted inputs/outputs to improve the
      // engine + future ML (HOR-325). Every field is scrubbed; the hint is
      // fail-closed (dropped if a secret survives), in which case we send nothing.
      if (isContentSharingEnabled()) {
        const hint = redactOrDrop(report.input.hint ?? '');
        if (!hint.dropped) {
          track({
            type: 'investigation.content',
            investigationId: report.id,
            hint: hint.value ?? '',
            summary: redactContent(report.summary ?? ''),
            findingTitles: (report.findings ?? [])
              .slice(0, 20)
              .map((f) => redactContent(f.title ?? '')),
            suspectedCauseTitles: (report.suspectedCauses ?? [])
              .slice(0, 20)
              .map((c) => redactContent(c.title ?? '')),
            confidence: typeof report.confidence === 'number' ? report.confidence : null,
          });
        }
      }

      if (cloudActive && cloudSession && cloudCfg) {
        try {
          const refs = await uploadInvestigationToCloud(cloudSession.client, cloudCfg, report);
          // Never write the human notice to STDOUT under --json — it corrupts the
          // machine-readable output (a trailing non-JSON line breaks every parser).
          const cloudNote = pc.dim(`[cloud] investigation saved: ${refs.investigationId}`);
          if (format === 'json') console.error(cloudNote);
          else console.log(cloudNote);
        } catch (err) {
          return reportCloudError(err);
        }
      }

      // HOR-319 (Bug 1): point the user at the id that `horus ask` accepts. report.id is
      // the local id printed in the header and now resolves in both local and cloud mode.
      if (format !== 'json') {
        if (report.persisted === false) {
          // DB-resilient degrade (HOR-319): the investigation store was unreachable,
          // so the report wasn't saved — be explicit instead of pointing at an id
          // that `horus ask` can't resolve.
          console.error(
            pc.yellow(`\n⚠ Results were not saved — the investigation database was unreachable.`),
          );
          console.error(
            pc.dim(
              `  This report is display-only; \`horus ask\` won't find it. Start the database and re-run to persist.`,
            ),
          );
        } else {
          console.log(pc.dim(`\nAsk a follow-up:  horus ask ${report.id} "<question>"`));
        }
        // Sampled, skippable impact prompt — never on non-TTY/--json (HOR-326).
        await maybePromptFeedback({
          investigationId: report.id,
          horusSeconds: (Date.now() - startedAtMs) / 1000,
        });
      }
    } finally {
      await sql.end();
      if (mongo) await mongo.close();
      if (queue) await queue.close();
    }

    return 0;
  } catch (err) {
    // Never fail silently: surface a message even when the error carries none,
    // and include the stack under HORUS_DEBUG for diagnosis.
    const msg = (err as Error)?.message || String(err);
    console.error(pc.red(msg.trim() ? msg : 'Investigation failed (unknown error).'));
    if (process.env.HORUS_DEBUG) console.error(pc.dim((err as Error)?.stack ?? String(err)));
    return 1;
  }
}
