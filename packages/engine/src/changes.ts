/**
 * HOR-8 change-impact primitive.
 * Computes which execution flows are affected by a set of code changes.
 */

import type { Symbol, Flow, ChangeSet } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';

export interface AffectedFlow {
  flowId: string;
  flowName: string;
  changedSymbols: string[];
}

export interface ChangeImpactReport {
  base: string;
  compare: string;
  added: Symbol[];
  removed: Symbol[];
  modified: { before: Symbol; after: Symbol }[];
  affectedFlows: AffectedFlow[];
  summary: string;
}

export async function changeImpact(
  input: { base: string; compare?: string },
  deps: { code: CodeProvider },
): Promise<ChangeImpactReport> {
  const compare = input.compare ?? 'HEAD';
  const changes: ChangeSet = await deps.code.detectChanges({ base: input.base, compare });

  // All "present-day" changed symbols — added + modified afters
  const presentSymbols: Symbol[] = [
    ...changes.added,
    ...changes.modified.map((m) => m.after),
  ];

  // Cap at 25 to bound source-intelligence calls; skip file-label ids for flow mapping
  const capped = presentSymbols
    .filter((s) => !s.id.startsWith('file:'))
    .slice(0, 25);

  // For each changed symbol, fetch flows (treat errors as no flows)
  const flowsPerSymbol: Flow[][] = await Promise.all(
    capped.map(async (s) => {
      try {
        return await deps.code.flowsFor(s.id);
      } catch {
        return [];
      }
    }),
  );

  // Accumulate into a Map<flowId, { flowName, changedSymbols: Set<string> }>
  const flowMap = new Map<string, { flowName: string; changedSymbols: Set<string> }>();

  for (let i = 0; i < capped.length; i++) {
    const sym = capped[i];
    if (sym === undefined) continue;
    const flows = flowsPerSymbol[i] ?? [];
    for (const flow of flows) {
      const existing = flowMap.get(flow.id);
      if (existing !== undefined) {
        existing.changedSymbols.add(sym.name);
      } else {
        flowMap.set(flow.id, {
          flowName: flow.name,
          changedSymbols: new Set([sym.name]),
        });
      }
    }
  }

  const affectedFlows: AffectedFlow[] = [...flowMap].map(([flowId, v]) => ({
    flowId,
    flowName: v.flowName,
    changedSymbols: [...v.changedSymbols],
  }));

  const summary =
    changes.added.length +
    ' added, ' +
    changes.modified.length +
    ' modified, ' +
    changes.removed.length +
    ' removed between ' +
    input.base +
    '..' +
    compare +
    '; ' +
    affectedFlows.length +
    ' execution flow(s) affected.';

  return {
    base: input.base,
    compare,
    added: changes.added,
    removed: changes.removed,
    modified: changes.modified,
    affectedFlows,
    summary,
  };
}
