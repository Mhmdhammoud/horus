/**
 * HOR-14 — Deterministic evidence correlation engine.
 *
 * Organises Evidence[] into groups, cause chains, and a missing-evidence
 * checklist so the AI (HOR-15) only has to explain — not discover — the facts.
 *
 * Pure and synchronous; no I/O, no randomness beyond what is baked into the
 * incoming evidence ids.
 */

import type { Evidence, EvidenceKind } from '@horus/core';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvidenceGroup {
  key: string;
  dimension: 'symbol' | 'file' | 'queue' | 'commit';
  reason: string;
  evidenceIds: string[];
}

export interface CauseChain {
  id: string;
  title: string;
  evidenceIds: string[];
  /** 0–1 deterministic strength derived from member relevance. */
  strength: number;
  rationale: string;
}

export interface MissingEvidence {
  kind: string;
  note: string;
}

export interface CorrelationResult {
  groups: EvidenceGroup[];
  chains: CauseChain[];
  missing: MissingEvidence[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp a number into the inclusive [0, 1] range. */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Parse producer and worker names from a queue-edge title such as:
 *   Queue "orders": OrderService -> OrderProcessor
 * Returns [producer, worker] or [null, null] on mismatch.
 */
function parseQueueEdgeTitle(title: string): [string | null, string | null] {
  const match = /Queue\s+"[^"]*":\s*(.+?)\s*->\s*(.+)$/.exec(title);
  if (!match) return [null, null];
  const producer = match[1]?.trim() ?? null;
  const worker = match[2]?.trim() ?? null;
  return [producer || null, worker || null];
}

/** Generate a stable, short synthetic id for a cause chain. */
function chainId(index: number, key: string): string {
  return `chain_${index}_${key.replace(/[^a-z0-9]/gi, '_').slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function buildGroups(evidence: Evidence[]): EvidenceGroup[] {
  // Map<key, { dimension, ids }>
  const symbolMap = new Map<string, string[]>();
  const fileMap = new Map<string, string[]>();
  const queueMap = new Map<string, string[]>();
  const commitGroup: string[] = [];

  for (const ev of evidence) {
    const { symbolId, file, queueName, commit } = ev.links;

    if (symbolId) {
      const list = symbolMap.get(symbolId) ?? [];
      list.push(ev.id);
      symbolMap.set(symbolId, list);
    }

    if (file) {
      const list = fileMap.get(file) ?? [];
      list.push(ev.id);
      fileMap.set(file, list);
    }

    if (queueName) {
      const list = queueMap.get(queueName) ?? [];
      list.push(ev.id);
      queueMap.set(queueName, list);
    }

    // Group commit-related evidence (evidence kind 'commit' or links.commit)
    if (ev.kind === 'commit' || commit) {
      commitGroup.push(ev.id);
    }
  }

  const raw: EvidenceGroup[] = [];

  for (const [key, ids] of symbolMap) {
    if (ids.length >= 2) {
      raw.push({
        key,
        dimension: 'symbol',
        reason: `Share symbol ${key}`,
        evidenceIds: [...ids],
      });
    }
  }

  for (const [key, ids] of fileMap) {
    if (ids.length >= 2) {
      raw.push({
        key,
        dimension: 'file',
        reason: `Share file ${key}`,
        evidenceIds: [...ids],
      });
    }
  }

  for (const [key, ids] of queueMap) {
    if (ids.length >= 2) {
      raw.push({
        key,
        dimension: 'queue',
        reason: `Share queue ${key}`,
        evidenceIds: [...ids],
      });
    }
  }

  if (commitGroup.length >= 2) {
    raw.push({
      key: 'commit',
      dimension: 'commit',
      reason: 'Share commit change presence',
      evidenceIds: [...commitGroup],
    });
  }

  // Sort: most evidence first, ties broken alphabetically by key (stable, deterministic).
  raw.sort((a, b) => {
    const diff = b.evidenceIds.length - a.evidenceIds.length;
    if (diff !== 0) return diff;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return raw;
}

// ---------------------------------------------------------------------------
// Cause chains
// ---------------------------------------------------------------------------

function buildChains(evidence: Evidence[]): CauseChain[] {
  const queueEdges = evidence.filter((e) => e.kind === 'queue-edge');
  const commitEvs = evidence.filter((e) => e.kind === 'commit');
  const symbolEvs = evidence.filter((e) => e.kind === 'symbol');

  // Lookup helpers
  const relevanceById = new Map<string, number>(evidence.map((e) => [e.id, e.relevance]));

  function avgRelevance(ids: string[]): number {
    if (ids.length === 0) return 0;
    let sum = 0;
    for (const id of ids) {
      sum += relevanceById.get(id) ?? 0;
    }
    return sum / ids.length;
  }

  const chains: CauseChain[] = [];

  if (queueEdges.length > 0) {
    // One chain per queue-edge evidence item.
    for (const edge of queueEdges) {
      const queueName = edge.links.queueName ?? '?';

      // Derive producer/worker from payload first, fall back to title parse.
      let producer: string | null = null;
      let worker: string | null = null;

      if (
        edge.payload !== null &&
        typeof edge.payload === 'object' &&
        !Array.isArray(edge.payload)
      ) {
        const p = edge.payload as Record<string, unknown>;
        if (typeof p['producerSymbol'] === 'string' && p['producerSymbol']) {
          producer = p['producerSymbol'];
        }
        if (typeof p['workerSymbol'] === 'string' && p['workerSymbol']) {
          worker = p['workerSymbol'];
        }
      }

      if (!producer || !worker) {
        const [tp, tw] = parseQueueEdgeTitle(edge.title);
        if (!producer) producer = tp ?? 'unknown-producer';
        if (!worker) worker = tw ?? 'unknown-worker';
      }

      const title = `Queue ${queueName} path: ${producer} -> ${worker}`;

      // Build member ids: start with the queue-edge, add any commit ids, add
      // the first matching seed symbol evidence if it links the same file/symbol.
      const memberIds: string[] = [edge.id];

      for (const c of commitEvs) {
        if (!memberIds.includes(c.id)) memberIds.push(c.id);
      }

      const seedEv = symbolEvs[0];
      if (seedEv && !memberIds.includes(seedEv.id)) {
        memberIds.push(seedEv.id);
      }

      const hasCommit = commitEvs.length > 0;
      const rationale = hasCommit
        ? 'A recent change is present and the implicated symbol sits on this queue boundary'
        : 'The implicated symbol sits on this queue boundary';

      const base = avgRelevance(memberIds);
      // +0.1 per extra linked evidence beyond the first.
      const strength = clamp01(base + 0.1 * Math.max(0, memberIds.length - 1));

      chains.push({
        id: chainId(chains.length, queueName),
        title,
        evidenceIds: memberIds,
        strength,
        rationale,
      });
    }
  } else {
    // No queue-edge: if there is at least one commit + one symbol, emit a single chain.
    const firstCommit = commitEvs[0];
    const firstSymbol = symbolEvs[0];

    if (firstCommit && firstSymbol) {
      const memberIds: string[] = [firstCommit.id, firstSymbol.id];
      const base = avgRelevance(memberIds);
      const strength = clamp01(base + 0.1 * Math.max(0, memberIds.length - 1));

      chains.push({
        id: chainId(0, 'recent_change'),
        title: 'Recent change to the implicated code',
        evidenceIds: memberIds,
        strength,
        rationale:
          'A recent change to the implicated symbol may have introduced the regression',
      });
    }
  }

  // Sort strongest first (descending strength, stable).
  chains.sort((a, b) => b.strength - a.strength);

  return chains;
}

// ---------------------------------------------------------------------------
// Missing evidence
// ---------------------------------------------------------------------------

const MISSING_NOTES: Record<string, string> = {
  log: 'No error logs collected for this investigation (Elasticsearch)',
  metric: 'No metrics collected — run `horus metrics "<hint>"` (Grafana)',
  'queue-state': 'No live queue depth/failure data (Redis/BullMQ)',
  'redis-key': 'No Redis state collected',
};

const RUNTIME_KINDS: EvidenceKind[] = ['log', 'metric', 'queue-state', 'redis-key'];

function buildMissing(evidence: Evidence[]): MissingEvidence[] {
  const presentKinds = new Set<string>(evidence.map((e) => e.kind));
  const missing: MissingEvidence[] = [];

  for (const kind of RUNTIME_KINDS) {
    if (!presentKinds.has(kind)) {
      const note = MISSING_NOTES[kind] ?? `No ${kind} evidence yet`;
      missing.push({ kind, note });
    }
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function correlate(evidence: Evidence[]): CorrelationResult {
  return {
    groups: buildGroups(evidence),
    chains: buildChains(evidence),
    missing: buildMissing(evidence),
  };
}
