/**
 * `horus eval` — the read-only accuracy harness (HOR-403).
 *
 * Two read paths over the converged outcome-label eval store (HOR-390):
 *   • `horus eval build`    — emit `corpus-<version>.jsonl` + a manifest (byte-stable for identical
 *                             inputs) for downstream analysis/training.
 *   • `horus eval baseline` — print Horus's measured hit-rate (SAME math as `horus memory accuracy`)
 *                             + a no-model feature-separation diagnostic over the cause-scoring
 *                             factors.
 *
 * READ-ONLY INVARIANT: nothing here ever writes the outcome_label store — only `horus feedback`
 * (source=feedback) and `horus memory confirm` (source=confirm) do. This command only reads labels +
 * joins investigation reports and writes its OWN artifact files (never the DB). It is project-scoped,
 * fail-closed (HOR-46), and reuses the exact read flags as `horus memory accuracy`
 * (--source/--days/--limit/--repo).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import {
  openDb,
  listOutcomeLabels,
  getInvestigation,
  isOutcomeSource,
  type OutcomeSource,
} from '@horus/db';
import {
  buildCorpus,
  serializeCorpus,
  computeBaseline,
  featureSeparation,
  CORPUS_VERSION,
  type ReportResolver,
} from '@horus/eval';

/** HOR-46 fail-closed project resolution — an unresolved project is a hard error, not a silent run. */
function resolveProject(
  config: Awaited<ReturnType<typeof loadConfig>>,
  repo: string | undefined,
): string | null {
  let project: string | undefined;
  try {
    project = resolveEnvironment(config, { project: repo }).project;
  } catch {
    /* unresolvable — handled below */
  }
  if (!project) {
    console.error(pc.red('Could not resolve a project — pass --repo <name> or run inside a repo.'));
    return null;
  }
  return project;
}

/** Validate + normalize the shared read flags (--source/--days/--limit), or null on bad input. */
function readSlice(opts: {
  source?: string;
  days?: number;
  limit?: number;
}): { source?: OutcomeSource; since?: Date; limit?: number } | null {
  let source: OutcomeSource | undefined;
  if (opts.source !== undefined) {
    if (!isOutcomeSource(opts.source)) {
      console.error(pc.red(`Unknown --source "${opts.source}" (one of: feedback, confirm).`));
      return null;
    }
    source = opts.source;
  }
  let since: Date | undefined;
  if (opts.days !== undefined) {
    if (!Number.isFinite(opts.days) || opts.days <= 0) {
      console.error(pc.red('--days must be a positive number.'));
      return null;
    }
    since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);
  }
  return { source, since, limit: opts.limit };
}

/**
 * Build a report resolver backed by the investigation store. Fetches each distinct, non-null
 * investigationId's stored report once into a Map; the resolver is then a pure lookup so
 * `buildCorpus` stays deterministic.
 */
async function loadReportResolver(
  db: Parameters<typeof getInvestigation>[0],
  ids: readonly (string | null)[],
): Promise<ReportResolver> {
  const map = new Map<string, unknown>();
  const distinct = [...new Set(ids.filter((id): id is string => id !== null))];
  for (const id of distinct) {
    const inv = await getInvestigation(db, id);
    map.set(id, inv?.report ?? null);
  }
  return (id: string) => map.get(id) ?? null;
}

/** `horus eval build` — emit the corpus + manifest (read-only). */
export async function runEvalBuild(opts: {
  config?: string;
  repo?: string;
  source?: string;
  days?: number;
  limit?: number;
  out?: string;
  version?: string;
  json?: boolean;
}): Promise<number> {
  try {
    const slice = readSlice(opts);
    if (slice === null) return 1;

    const config = await loadConfig(opts.config);
    const project = resolveProject(config, opts.repo);
    if (!project) return 1;

    const version = opts.version ?? CORPUS_VERSION;
    const outDir = opts.out
      ? isAbsolute(opts.out)
        ? opts.out
        : resolve(process.cwd(), opts.out)
      : join(process.cwd(), '.horus', 'eval');

    const { db, sql } = await openDb(config.database.url);
    try {
      const labels = await listOutcomeLabels(db, {
        project,
        source: slice.source,
        since: slice.since,
        limit: slice.limit,
      });
      const resolveReport = await loadReportResolver(
        db,
        labels.map((l) => l.investigationId),
      );
      const build = buildCorpus(labels, resolveReport);
      const artifact = serializeCorpus(build, version);

      await mkdir(outDir, { recursive: true });
      const corpusPath = join(outDir, artifact.filename);
      const manifestPath = join(outDir, `corpus-${version}.manifest.json`);
      // Stamp the manifest (NOT the deterministic jsonl) with a generation time on write.
      const manifest = { ...artifact.manifest, generatedAt: new Date().toISOString(), project };
      await writeFile(corpusPath, artifact.jsonl, 'utf8');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

      if (opts.json) {
        console.log(JSON.stringify({ project, corpusPath, manifestPath, manifest }, null, 2));
      } else {
        console.log(pc.bold(`Eval corpus — ${project}`));
        console.log(
          `  Rows: ${pc.green(String(build.rows.length))} ` +
            pc.dim(
              `(evaluated ${build.evaluated}, quarantined ${build.quarantined.length}, unjoinable ${build.unjoinable.length})`,
            ),
        );
        console.log(
          pc.dim(
            `  Class balance: ${build.classBalance.yes} yes, ${build.classBalance.partly} partly, ${build.classBalance.no} no · ` +
              `source: ${build.bySource.feedback} feedback, ${build.bySource.confirm} confirm`,
          ),
        );
        console.log(`  Corpus:   ${pc.cyan(corpusPath)}`);
        console.log(`  Manifest: ${pc.cyan(manifestPath)}`);
      }
      return 0;
    } finally {
      await sql.end();
    }
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

/** `horus eval baseline` — print the baseline hit-rate + feature-separation diagnostic (read-only). */
export async function runEvalBaseline(opts: {
  config?: string;
  repo?: string;
  source?: string;
  days?: number;
  limit?: number;
  json?: boolean;
}): Promise<number> {
  try {
    const slice = readSlice(opts);
    if (slice === null) return 1;

    const config = await loadConfig(opts.config);
    const project = resolveProject(config, opts.repo);
    if (!project) return 1;

    const { db, sql } = await openDb(config.database.url);
    try {
      const labels = await listOutcomeLabels(db, {
        project,
        source: slice.source,
        since: slice.since,
        limit: slice.limit,
      });
      // Baseline math mirrors `horus memory accuracy` exactly (shared summarizeOutcomeLabels).
      const baseline = computeBaseline(labels);
      // The diagnostic needs the joined reports' cause-scoring factors.
      const resolveReport = await loadReportResolver(
        db,
        labels.map((l) => l.investigationId),
      );
      const build = buildCorpus(labels, resolveReport);
      const separation = featureSeparation(build.rows);

      if (opts.json) {
        console.log(JSON.stringify({ project, baseline, separation }, null, 2));
      } else {
        const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
        console.log(pc.bold(`Eval baseline — ${project}`));
        if (baseline.n === 0) {
          console.log(
            pc.dim(
              'No outcome labels yet. Leave feedback (`horus feedback`) or confirm an investigation ' +
                '(`horus memory confirm`) to seed the eval set.',
            ),
          );
        } else {
          console.log(
            `  Strict hit-rate: ${pc.green(pct(baseline.strictHitRate))} ` +
              pc.dim(`(weighted ${pct(baseline.weightedHitRate)}) over ${baseline.n} investigation(s)`),
          );
          console.log(
            `  Class balance: ${pc.green(`${baseline.classBalance.yes} yes`)}, ` +
              `${pc.yellow(`${baseline.classBalance.partly} partly`)}, ${pc.red(`${baseline.classBalance.no} no`)} · ` +
              pc.dim(`source: ${baseline.bySource.feedback} feedback, ${baseline.bySource.confirm} confirm`),
          );
          if (separation.factors.length === 0) {
            console.log(
              pc.dim(
                `  Feature separation: no discriminative sample yet ` +
                  `(needs feedback rows with yes AND no verdicts and a ranked cause).`,
              ),
            );
          } else {
            console.log(pc.dim(`  Feature separation (yes vs no, ${separation.evaluated} row(s)):`));
            for (const f of separation.factors.slice(0, 10)) {
              console.log(
                pc.dim(
                  `    ${f.factor}: Δ ${f.separation.toFixed(3)} ` +
                    `(yes ${f.meanYes.toFixed(3)} vs no ${f.meanNo.toFixed(3)}, effect ${f.effectSize.toFixed(2)})`,
                ),
              );
            }
          }
        }
      }
      return 0;
    } finally {
      await sql.end();
    }
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
