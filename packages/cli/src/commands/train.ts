/**
 * `horus train` (HOR-404 / HOR-442) — fit the LOCAL, per-tenant reranker over the outcome-label
 * corpus.
 *
 * Training is LOCAL and per-tenant: the corpus never leaves the client, and the model is a few kB of
 * logistic weights written to `~/.horus/reranker.json`. It is honesty-gated:
 *   • refuses below {@link MIN_TRAIN_INVESTIGATIONS} labeled investigations ("keep using feedback");
 *   • only writes a model when it BEATS the hand-tuned baseline on the deterministic holdout
 *     (delta > 0) — otherwise it reports the result and leaves Horus on its deterministic ranking.
 *
 * READ-ONLY on the label store (only `horus feedback` / `horus memory confirm` write labels); this
 * command reads labels + joins reports and writes ONLY its own model file.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import {
  openDb,
  listOutcomeLabels,
  getInvestigation,
  dedupeToCurrentVerdict,
  isOutcomeResolved,
  isOutcomeSource,
  type OutcomeSource,
} from '@horus/db';
import type { CauseCandidate } from '@horus/engine';
import {
  holdoutSplit,
  trainReranker,
  MIN_TRAIN_INVESTIGATIONS,
  type RerankInvestigation,
  type RankableCause,
} from '@horus/eval';

/** Where the local, per-tenant model lives (loaded by `horus investigate` when enabled). */
export const RERANKER_MODEL_PATH = join(homedir(), '.horus', 'reranker.json');

/** Pull the full ranked candidate set off a stored report blob, or null if missing/legacy. */
function candidatesFromReport(blob: unknown): RankableCause[] | null {
  if (blob === null || typeof blob !== 'object') return null;
  const causes = (blob as { suspectedCauses?: unknown }).suspectedCauses;
  if (!Array.isArray(causes)) return null;
  return causes as CauseCandidate[];
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export async function runTrain(opts: {
  config?: string;
  source?: string;
  days?: number;
  limit?: number;
}): Promise<number> {
  // Validate the shared read slice.
  let source: OutcomeSource | undefined;
  if (opts.source !== undefined) {
    if (!isOutcomeSource(opts.source)) {
      console.error(pc.red(`Unknown --source "${opts.source}" (one of: feedback, confirm).`));
      return 1;
    }
    source = opts.source;
  }
  let since: Date | undefined;
  if (opts.days !== undefined) {
    if (!Number.isFinite(opts.days) || opts.days <= 0) {
      console.error(pc.red('--days must be a positive number.'));
      return 1;
    }
    since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);
  }

  let investigations: RerankInvestigation[];
  try {
    const config = await loadConfig(opts.config);
    const { db, sql } = await openDb(config.database.url);
    try {
      // All local labels (no project filter) — a per-tenant reranker trains on the whole corpus.
      const labels = await listOutcomeLabels(db, {
        ...(source ? { source } : {}),
        ...(since ? { since } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
      });
      const current = dedupeToCurrentVerdict(labels);
      investigations = [];
      for (const label of current) {
        if (label.investigationId === null) continue;
        if (!isOutcomeResolved(label.resolved) || !isOutcomeSource(label.source)) continue;
        const inv = await getInvestigation(db, label.investigationId);
        const candidates = candidatesFromReport(inv?.report ?? null);
        if (candidates === null) continue;
        const isConfirm = label.source === 'confirm';
        investigations.push({
          investigationId: label.investigationId,
          target: label.resolved,
          // confirm's confirmedCause is Horus's own summary (circular) — drop it, like the corpus.
          confirmedCause: isConfirm ? null : (label.confirmedCause ?? null),
          candidates,
        });
      }
    } finally {
      await sql.end();
    }
  } catch (err) {
    console.error(pc.red(`Could not read the local corpus: ${(err as Error).message}`));
    return 1;
  }

  const split = holdoutSplit(investigations);
  const result = trainReranker(investigations, new Set(split.holdout));

  if (!result.ok) {
    if (result.reason === 'insufficient-corpus') {
      console.log(
        pc.yellow(
          `Not enough labeled investigations to train yet (have ${result.labeledInvestigations} with a known-correct cause; need ≥${MIN_TRAIN_INVESTIGATIONS}).`,
        ),
      );
      console.log(pc.dim('  Keep labeling outcomes with `horus feedback` — the reranker trains once the corpus is large enough.'));
    } else {
      console.log(pc.yellow(`Cannot train a meaningful model yet: ${result.detail}.`));
    }
    return 0;
  }

  const { baselineHitRate, rerankedHitRate, delta, n } = result.holdout;
  console.log(pc.bold('\nReranker training (local, per-tenant)\n'));
  console.log(`  Holdout investigations:  ${n}`);
  console.log(`  Baseline top-1 hit-rate: ${pct(baselineHitRate)}`);
  console.log(`  Reranked top-1 hit-rate: ${pct(rerankedHitRate)}`);
  console.log(`  Delta:                   ${delta >= 0 ? '+' : ''}${pct(delta)}`);
  console.log('');

  if (delta <= 0) {
    console.log(pc.yellow('  The reranker did NOT beat the deterministic baseline — not saving a model.'));
    console.log(pc.dim('  Horus stays on its hand-tuned ranking. Re-run as more labels accumulate.'));
    return 0;
  }

  try {
    await mkdir(join(homedir(), '.horus'), { recursive: true });
    // Strip the transient `ok` flag — persist just the model.
    const { ok: _ok, ...model } = result;
    void _ok;
    await writeFile(RERANKER_MODEL_PATH, JSON.stringify(model, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error(pc.red(`Trained, but could not write the model: ${(err as Error).message}`));
    return 1;
  }

  console.log(pc.green(`  ✓ Reranker beats baseline by +${pct(delta)} — saved to ${RERANKER_MODEL_PATH}`));
  console.log(pc.dim('  It ships OFF by default. Enable it with `HORUS_RERANK=1 horus investigate …`.'));
  return 0;
}
