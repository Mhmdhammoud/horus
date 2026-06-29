/**
 * HOR-438b — Unit tests for detectPerSegmentDispatch (pure, no I/O).
 *
 * Detects a per-segment DISPATCH from the seed's CODE alone (no telemetry): a function whose
 * signature takes a SEGMENT DIMENSION parameter (market/region/tenant/shard/…) and is therefore
 * invoked once per segment. This is the sibling to detectPerSegmentQueues for the case the
 * queue-suffix detector cannot see (ONE logical queue, per-market split in code). It is a
 * code-grounded SUPPORT for benign-variance — never a verdict.
 */

import { describe, it, expect } from 'vitest';
import type { Evidence, SymbolContext } from '@horus/core';
import type { CorrelationResult } from './correlate.js';
import { detectPerSegmentDispatch } from './engine.js';
import { generateHypotheses } from './hypotheses.js';
import { validateHypotheses } from './validate.js';

function ctx(opts: {
  name?: string;
  signature?: string;
  sourceBody?: string;
  callers?: SymbolContext['callers'];
}): SymbolContext {
  const symbol: SymbolContext['symbol'] = {
    id: `sym:${opts.name ?? 'fn'}`,
    name: opts.name ?? 'fn',
    filePath: 'src/sales.ts',
    startLine: 10,
  };
  if (opts.signature !== undefined) symbol.signature = opts.signature;
  const out: SymbolContext = {
    symbol,
    callers: opts.callers ?? [],
    callees: [],
    imports: [],
    usesType: [],
    community: null,
    coupledWith: [],
  };
  if (opts.sourceBody !== undefined) out.sourceBody = opts.sourceBody;
  return out;
}

describe('detectPerSegmentDispatch (HOR-438b)', () => {
  it('FIRES on a seed whose param TYPE is a segment enum (mt: MarketType), with queue fan-out', () => {
    // Param NAME `mt` is not in the vocab — only the segment-like PascalCase TYPE proves it.
    const out = detectPerSegmentDispatch(
      ctx({ name: 'manageSalesForMarket', signature: 'manageSalesForMarket(mt: MarketType): Promise<void>' }),
      [{ queueName: 'MANAGE_SALES', producerSymbol: 'scheduler', workerSymbol: 'manageSalesForMarket' }],
      [],
    );
    expect(out).not.toBeNull();
    expect(out!.symbol).toBe('manageSalesForMarket');
    expect(out!.paramName).toBe('mt');
    expect(out!.paramType).toBe('MarketType');
    expect(out!.matchedBy).toBe('type');
    expect(out!.fanOut).toBe('queue');
  });

  it('FIRES on the maison-safqa shape (marketType: MarketType) — de-camel name match also works', () => {
    const out = detectPerSegmentDispatch(
      ctx({ name: 'manageSalesForMarket', signature: 'manageSalesForMarket(marketType: MarketType): Promise<void>' }),
      [],
      [],
    );
    expect(out).not.toBeNull();
    expect(out!.paramName).toBe('marketType');
    expect(out!.matchedBy).toBe('name'); // "market Type" matches the curated NAME vocab
  });

  it('FIRES on a param NAME in the curated vocab (region) — param signal alone is sufficient', () => {
    const out = detectPerSegmentDispatch(
      ctx({ name: 'syncRegion', signature: 'function syncRegion(region: string): void' }),
      [],
      [],
    );
    expect(out).not.toBeNull();
    expect(out!.paramName).toBe('region');
    expect(out!.matchedBy).toBe('name');
    expect(out!.fanOut).toBe('none'); // no corroboration needed to fire
  });

  it('FIRES on a camelCase segment name (tenantId) via de-camel matching', () => {
    const out = detectPerSegmentDispatch(
      ctx({ name: 'processForTenant', signature: 'processForTenant(tenantId: string)' }),
      [],
      [],
    );
    expect(out).not.toBeNull();
    expect(out!.paramName).toBe('tenantId');
    expect(out!.matchedBy).toBe('name');
  });

  it('records a caller-loop fan-out when a caller body loops over a segment collection and calls the seed', () => {
    const out = detectPerSegmentDispatch(
      ctx({ name: 'manageSalesForMarket', signature: 'manageSalesForMarket(marketType: MarketType)' }),
      [],
      [
        { name: 'runAll', sourceBody: 'for (const market of markets) { await manageSalesForMarket(market); }' },
      ],
    );
    expect(out).not.toBeNull();
    expect(out!.fanOut).toBe('caller-loop');
  });

  it('parses the signature from the START of sourceBody when no dedicated signature field exists', () => {
    const out = detectPerSegmentDispatch(
      ctx({
        name: 'handleShard',
        sourceBody: 'export async function handleShard(shard: ShardId) {\n  // ... lots of body ...\n}',
      }),
      [],
      [],
    );
    expect(out).not.toBeNull();
    expect(out!.paramName).toBe('shard');
    expect(out!.paramType).toBe('ShardId');
  });

  it('does NOT fire on a generic param (id)', () => {
    expect(
      detectPerSegmentDispatch(ctx({ name: 'getThing', signature: 'getThing(id: string)' }), [], []),
    ).toBeNull();
  });

  it('does NOT fire on a generic param (data/payload)', () => {
    expect(
      detectPerSegmentDispatch(
        ctx({ name: 'process', signature: 'process(data: unknown, payload: Buffer)' }),
        [],
        [],
      ),
    ).toBeNull();
  });

  it('does NOT fire on a generic PascalCase type whose root is not a segment word (ProductType)', () => {
    expect(
      detectPerSegmentDispatch(
        ctx({ name: 'classify', signature: 'classify(kind: ProductType)' }),
        [],
        [],
      ),
    ).toBeNull();
  });

  it('does NOT misread a generic name even when a segment word appears as a substring without a boundary (accountId stays segment, but ctx is generic)', () => {
    // `ctx` is in the generic deny-set — never fires even if some other token looks segment-ish.
    expect(
      detectPerSegmentDispatch(ctx({ name: 'run', signature: 'run(ctx: AppContext)' }), [], []),
    ).toBeNull();
  });

  it('does not fabricate when the signature has no parameter list', () => {
    expect(detectPerSegmentDispatch(ctx({ name: 'tick', signature: 'tick' }), [], [])).toBeNull();
  });
});

// ── benign-variance channel (HOR-438b reuses the HOR-438 perSegmentQueueStructureEvIds) ──────

const emptyCorrelation: CorrelationResult = {
  groups: [],
  chains: [],
  missing: [],
};

function makeEvidence(kind: Evidence['kind'], id: string): Evidence {
  const source: Evidence['source'] =
    kind === 'commit' ? 'history'
    : kind === 'queue-edge' || kind === 'queue-state' ? 'queue'
    : kind === 'log' ? 'logs'
    : kind === 'metric' ? 'metrics'
    : kind === 'state' || kind === 'redis-key' ? 'state'
    : 'code';
  return {
    id,
    source,
    kind,
    title: `Test evidence (${kind})`,
    relevance: 0.4,
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };
}

describe('benign-variance rises on a code-detected per-segment DISPATCH (HOR-438b)', () => {
  it('benign-variance is SUPPORTED when the dispatch evidence id is present', () => {
    const dispatchId = 'per-segment-dispatch-ev';
    const evidence = [makeEvidence('symbol', dispatchId)];
    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'manageSalesForMarket',
      queues: [],
      // HOR-438b feeds the SAME benignSupport channel as the queue structure.
      perSegmentQueueStructureEvIds: [dispatchId],
    });
    const bv = hyps.find((h) => h.category === 'benign-variance');
    expect(bv).toBeDefined();
    // Base prior stays LOW (honesty) — the dispatch is support, not a verdict.
    expect(bv!.confidence).toBe(0.1);
    expect(bv!.supportingEvidenceIds).toContain(dispatchId);
    expect(bv!.missingEvidence).toHaveLength(0);
    const [validated] = validateHypotheses([bv!], evidence);
    expect(validated!.verdict).toBe('supported');
    expect(validated!.confidence).toBeGreaterThan(0.1);
    expect(validated!.confidence).toBeLessThan(1);
  });

  it('a genuine failure still OUTRANKS benign-variance even with the dispatch support present', () => {
    const commitId = 'real-regression-commit';
    const dispatchId = 'per-segment-dispatch-ev';
    const evidence = [makeEvidence('commit', commitId), makeEvidence('symbol', dispatchId)];
    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'manageSalesForMarket',
      queues: [],
      perSegmentQueueStructureEvIds: [dispatchId],
    });
    const validated = validateHypotheses(hyps, evidence);
    const bv = validated.find((h) => h.category === 'benign-variance')!;
    const dr = validated.find((h) => h.category === 'deployment-regression')!;
    expect(bv).toBeDefined();
    expect(dr).toBeDefined();
    expect(dr.confidence).toBeGreaterThan(bv.confidence);
    expect(validated[0]!.category).not.toBe('benign-variance');
  });
});
