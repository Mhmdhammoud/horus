import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createDb } from '@horus/db';
import { listQueueEdges } from '@horus/db';
import type { QueueEdge } from '@horus/db';
import { queueForEnv } from '@horus/connectors';
import type { QueueCounts } from '@horus/connectors';

export async function runQueues(
  name: string | undefined,
  opts: { config?: string; project?: string; name?: string; live?: boolean },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config, { name: opts.name });
    const { db, sql } = createDb(config.database.url);

    try {
      const rows = await listQueueEdges(db, { project: opts.project, queueName: name });

      // ── Source topology ──────────────────────────────────────────────────────
      console.log(
        pc.bold('Queue topology') +
          pc.dim('  ·  source: code / source intelligence  ·  static (run horus index to refresh)'),
      );
      console.log('');

      if (rows.length === 0) {
        console.log(pc.dim('  No queue edges indexed. Run: horus index'));
      } else {
        const byQueue = buildQueueMap(rows);
        printTopology(byQueue);
      }

      // ── Live queue state ─────────────────────────────────────────────────────
      console.log('');

      if (opts.live) {
        await runLiveMode(config, rows, name);
      } else {
        console.log(
          pc.dim(
            '  Tip: run horus queues --live to show real-time Redis/BullMQ depths and failed-job counts.',
          ),
        );
      }
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Topology helpers
// ---------------------------------------------------------------------------

function buildQueueMap(rows: QueueEdge[]): Map<string, QueueEdge[]> {
  const byQueue = new Map<string, QueueEdge[]>();
  for (const row of rows) {
    const existing = byQueue.get(row.queueName);
    if (existing) {
      existing.push(row);
    } else {
      byQueue.set(row.queueName, [row]);
    }
  }
  return byQueue;
}

function printTopology(byQueue: Map<string, QueueEdge[]>): void {
  for (const [queueName, edges] of byQueue) {
    console.log(pc.bold(queueName));

    // Distinct non-null producerSymbol values
    const producerSet = new Set<string>();
    const producerDetails = new Map<string, string>();
    for (const edge of edges) {
      if (edge.producerSymbol) {
        producerSet.add(edge.producerSymbol);
        if (edge.producerFile) producerDetails.set(edge.producerSymbol, edge.producerFile);
      }
    }

    if (producerSet.size === 0) {
      console.log('  producers: ' + pc.dim('none'));
    } else {
      const list = Array.from(producerSet)
        .map((sym) => {
          const file = producerDetails.get(sym);
          return file ? `${sym} (${file})` : sym;
        })
        .join(', ');
      console.log('  producers: ' + list);
    }

    // Distinct non-null workerSymbol values
    const workerSet = new Set<string>();
    const workerDetails = new Map<string, string>();
    for (const edge of edges) {
      if (edge.workerSymbol) {
        workerSet.add(edge.workerSymbol);
        if (edge.workerFile) workerDetails.set(edge.workerSymbol, edge.workerFile);
      }
    }

    if (workerSet.size === 0) {
      console.log('  workers: ' + pc.dim('none'));
    } else {
      const list = Array.from(workerSet)
        .map((sym) => {
          const file = workerDetails.get(sym);
          return file ? `${sym} (${file})` : sym;
        })
        .join(', ');
      console.log('  workers: ' + list);
    }

    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

async function runLiveMode(
  config: Awaited<ReturnType<typeof loadConfig>>,
  rows: QueueEdge[],
  nameFilter: string | undefined,
): Promise<void> {
  let renv: ReturnType<typeof resolveEnvironment>;
  try {
    renv = resolveEnvironment(config);
  } catch (err) {
    console.log(pc.bold('Live queue state') + pc.dim('  ·  source: Redis/BullMQ'));
    console.log(pc.yellow(`  ⚠ Cannot resolve environment: ${(err as Error).message}`));
    return;
  }

  const queueProvider = queueForEnv(renv);

  if (!queueProvider) {
    console.log(pc.bold('Live queue state') + pc.dim('  ·  source: Redis/BullMQ'));
    console.log(
      pc.yellow('  ○ Redis not configured — run: ') + pc.bold('horus connect redis'),
    );
    return;
  }

  let headerPrinted = false;
  try {
    // Probe reachability first
    const health = await queueProvider.health();
    if (!health.ok) {
      console.log(pc.bold('Live queue state') + pc.dim('  ·  source: Redis/BullMQ'));
      console.log(pc.red(`  ✗ Redis unreachable: ${health.detail}`));
      return;
    }

    // Use topology queue names if available; otherwise let the client discover.
    const topologyNames = [...buildQueueMap(rows).keys()];
    const queueNames =
      nameFilter !== undefined
        ? [nameFilter]
        : topologyNames.length > 0
          ? topologyNames
          : undefined;

    const state = await queueProvider.analyzeQueues({ queueNames });
    const collectedAt = new Date(state.collectedAt).toLocaleTimeString();

    console.log(
      pc.bold('Live queue state') +
        pc.dim(`  ·  source: Redis/BullMQ (prefix: ${state.prefix})  ·  collected: ${collectedAt}`),
    );
    headerPrinted = true;
    console.log('');

    if (state.queues.length === 0) {
      console.log(pc.dim('  No queues found in Redis.'));
      console.log(
        pc.dim(
          '  If queues exist under a custom prefix, set the BullMQ prefix in your connector config.',
        ),
      );
      return;
    }

    printLiveTable(state.queues);
  } catch (err) {
    if (!headerPrinted) {
      console.log(pc.bold('Live queue state') + pc.dim('  ·  source: Redis/BullMQ'));
    }
    console.log(pc.red(`  ✗ ${(err as Error).message}`));
  } finally {
    await queueProvider.close().catch(() => {});
  }
}

function printLiveTable(queues: QueueCounts[]): void {
  // Column widths
  const nameWidth = Math.max(10, ...queues.map((q) => q.queueName.length));
  const numWidth = 7;

  const header =
    '  ' +
    'queue'.padEnd(nameWidth) +
    '  ' +
    'waiting'.padStart(numWidth) +
    '  ' +
    'active'.padStart(numWidth) +
    '  ' +
    'failed'.padStart(numWidth) +
    '  ' +
    'delayed'.padStart(numWidth) +
    '  ' +
    'paused'.padStart(numWidth);
  console.log(pc.dim(header));
  console.log(pc.dim('  ' + '─'.repeat(header.length - 2)));

  for (const q of queues) {
    const hasIssue = q.failed > 0 || q.waiting > 100 || q.delayed > 50 || q.isPaused;
    const color = hasIssue ? pc.yellow : (s: string) => s;

    const row =
      '  ' +
      q.queueName.padEnd(nameWidth) +
      '  ' +
      String(q.waiting).padStart(numWidth) +
      '  ' +
      String(q.active).padStart(numWidth) +
      '  ' +
      String(q.failed).padStart(numWidth) +
      '  ' +
      String(q.delayed).padStart(numWidth) +
      '  ' +
      (q.isPaused ? pc.yellow('paused') : String(q.paused).padStart(numWidth));
    console.log(color(row));

    // Oldest waiting job
    if (q.oldestWaitingMs !== undefined) {
      const age = formatAge(q.oldestWaitingMs);
      console.log(pc.dim(`    oldest waiting: ${age}`));
    }

    // Failed breakdown
    if (q.failedBreakdown && q.failedBreakdown.length > 0) {
      for (const { reason, count } of q.failedBreakdown.slice(0, 3)) {
        console.log(pc.red(`    ✗ [${count}x] ${reason}`));
      }
    }
  }
  console.log('');
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
