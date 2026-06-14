import type { CodeProvider } from '@horus/connectors';
import type { Symbol } from '@horus/core';
import { listQueueEdges, type HorusDb } from '@horus/db';

export interface AsyncDependency {
  queueName: string;
  counterpart: string;
  counterpartFile: string | null;
}

export interface BlastRadiusReport {
  seed: Symbol;
  upstream: Symbol[];
  downstream: { depth: number; symbols: Symbol[] }[];
  asyncUpstream: AsyncDependency[];
  asyncDownstream: AsyncDependency[];
  blastRadius: number;
  criticality: 'low' | 'medium' | 'high';
  summary: string;
  note: string;
}

export async function analyzeBlastRadius(
  query: string,
  deps: { code: CodeProvider; db: HorusDb },
  depth = 3,
): Promise<BlastRadiusReport | null> {
  const seeds = await deps.code.searchSymbols(query, 5);
  const top = seeds[0];
  if (!top) return null;

  const [ctx, impact] = await Promise.all([
    deps.code.context(top.id),
    deps.code.impact(top.id, depth),
  ]);

  // upstream = what the seed depends on (callees)
  const upstream: Symbol[] = ctx.callees;

  // downstream = callers by depth = affected if the seed fails
  const downstream: { depth: number; symbols: Symbol[] }[] = impact.byDepth;

  const edges = await listQueueEdges(deps.db);

  // asyncDownstream: seed is the producer -> workers are downstream
  const asyncDownstreamMap = new Map<string, AsyncDependency>();
  for (const edge of edges) {
    if (edge.producerFile === top.filePath || edge.producerSymbol === top.name) {
      const key = edge.queueName + '|' + (edge.workerSymbol ?? 'unknown-worker');
      if (!asyncDownstreamMap.has(key)) {
        asyncDownstreamMap.set(key, {
          queueName: edge.queueName,
          counterpart: edge.workerSymbol ?? 'unknown-worker',
          counterpartFile: edge.workerFile,
        });
      }
    }
  }
  const asyncDownstream: AsyncDependency[] = Array.from(asyncDownstreamMap.values());

  // asyncUpstream: seed is the worker -> producers are upstream
  const asyncUpstreamMap = new Map<string, AsyncDependency>();
  for (const edge of edges) {
    if (edge.workerFile === top.filePath || edge.workerSymbol === top.name) {
      const key = edge.queueName + '|' + (edge.producerSymbol ?? 'unknown-producer');
      if (!asyncUpstreamMap.has(key)) {
        asyncUpstreamMap.set(key, {
          queueName: edge.queueName,
          counterpart: edge.producerSymbol ?? 'unknown-producer',
          counterpartFile: edge.producerFile,
        });
      }
    }
  }
  const asyncUpstream: AsyncDependency[] = Array.from(asyncUpstreamMap.values());

  const blastRadius = impact.affected + asyncDownstream.length;

  const criticality: 'low' | 'medium' | 'high' =
    blastRadius >= 10 ? 'high' : blastRadius >= 3 ? 'medium' : 'low';

  const summary =
    'If ' +
    top.name +
    ' (' +
    top.filePath +
    ') fails, ~' +
    blastRadius +
    ' symbol(s) are affected downstream' +
    (asyncDownstream.length
      ? ' (incl. ' + asyncDownstream.length + ' across async queue boundaries)'
      : '') +
    '; it depends on ' +
    upstream.length +
    ' symbol(s) upstream' +
    (asyncUpstream.length ? ' + ' + asyncUpstream.length + ' async producer(s)' : '') +
    '. Criticality: ' +
    criticality +
    '.';

  const note =
    'The component reporting an error is often not the cause — inspect the upstream dependencies first.';

  return {
    seed: top,
    upstream,
    downstream,
    asyncUpstream,
    asyncDownstream,
    blastRadius,
    criticality,
    summary,
    note,
  };
}
