/**
 * HOR-14 — Investigation Graph.
 *
 * Models the infrastructure topology implicit in a set of normalized Evidence
 * items: queues, services, workers, collections, and deployments as nodes;
 * emits/consumes/observed_in/… as edges. Used by the engine to identify which
 * nodes sit on the suspected-cause path and to score them for downstream ranking.
 */

import type { Evidence } from '@horus/core';

// ── Node and edge type unions ──────────────────────────────────────────────────

export type GraphNodeType =
  | 'service'         // a running software service
  | 'queue'           // a BullMQ job queue
  | 'worker'          // a queue consumer / worker process
  | 'database'        // a database server (MongoDB, Redis)
  | 'collection'      // a MongoDB collection
  | 'deployment'      // a git commit / deployment event
  | 'evidence'        // a raw evidence item not mapped to infrastructure
  | 'external_system' // an external dependency (third-party API, SaaS, etc.)
  | 'unknown';

export type GraphEdgeType =
  | 'emits'            // service → queue: service enqueues jobs
  | 'consumes'         // queue → worker: worker processes jobs from queue
  | 'writes_to'        // service/worker → collection: writes data
  | 'reads_from'       // service/worker → collection: reads data
  | 'depends_on'       // service → service: general dependency
  | 'caused_by'        // node → node: causal relationship
  | 'correlated_with'  // node → node: correlation (not necessarily causal)
  | 'observed_in';     // evidence → infrastructure: where the evidence was observed

// ── Graph model ────────────────────────────────────────────────────────────────

export interface GraphNode {
  /** Stable content-derived id, e.g. `"queue:payments"`, `"service:api"`. */
  id: string;
  type: GraphNodeType;
  /** Human-readable display name. */
  label: string;
  /** Evidence items that created or reference this node. */
  evidenceIds: string[];
  /**
   * True when high-relevance evidence is attached to this node or a direct
   * neighbour. Set by the implication-scoring pass after graph construction.
   */
  implicated: boolean;
  /**
   * 0–1; max relevance of directly-attached evidence, propagated one hop to
   * neighbours. Used by `maxImplicationScore()` to boost suspected-cause scores.
   */
  implicationScore: number;
}

export interface GraphEdge {
  /** Stable content-derived id: `"{from}--{type}-->{to}"`. */
  id: string;
  type: GraphEdgeType;
  from: string;
  to: string;
  /** Evidence items that justify this edge. */
  evidenceIds: string[];
}

export interface InvestigationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Builder internals ──────────────────────────────────────────────────────────

type NodeMap = Map<string, GraphNode>;
type EdgeMap = Map<string, GraphEdge>;

function upsertNode(
  nodes: NodeMap,
  id: string,
  type: GraphNodeType,
  label: string,
  evidenceId?: string,
): GraphNode {
  let node = nodes.get(id);
  if (!node) {
    node = { id, type, label, evidenceIds: [], implicated: false, implicationScore: 0 };
    nodes.set(id, node);
  }
  if (evidenceId !== undefined && !node.evidenceIds.includes(evidenceId)) {
    node.evidenceIds.push(evidenceId);
  }
  return node;
}

function addEdge(
  edges: EdgeMap,
  type: GraphEdgeType,
  from: string,
  to: string,
  evidenceId?: string,
): void {
  const id = `${from}--${type}-->${to}`;
  let edge = edges.get(id);
  if (!edge) {
    edge = { id, type, from, to, evidenceIds: [] };
    edges.set(id, edge);
  }
  if (evidenceId !== undefined && !edge.evidenceIds.includes(evidenceId)) {
    edge.evidenceIds.push(evidenceId);
  }
}

// Minimal typed views of evidence payloads — cast from opaque `unknown`.
interface QueueEdgePayload { queueName?: string; producerSymbol?: string; workerSymbol?: string }
interface QueueStatePayload { queueName?: string }
interface LogPayload { services?: string[] }
interface StatePayload { collection?: string }

function processEvidence(ev: Evidence, nodes: NodeMap, edges: EdgeMap): void {
  const evId = `ev:${ev.id}`;
  upsertNode(nodes, evId, 'evidence', ev.title, ev.id);

  switch (ev.kind) {
    case 'queue-edge': {
      const p = ev.payload as QueueEdgePayload;
      const qName = p.queueName ?? ev.links.queueName;
      if (!qName) return;
      const queueId = `queue:${qName}`;
      upsertNode(nodes, queueId, 'queue', qName, ev.id);
      addEdge(edges, 'observed_in', evId, queueId, ev.id);
      if (p.producerSymbol) {
        const producerId = `service:${p.producerSymbol}`;
        upsertNode(nodes, producerId, 'service', p.producerSymbol, ev.id);
        addEdge(edges, 'emits', producerId, queueId, ev.id);
      }
      if (p.workerSymbol) {
        const workerId = `worker:${p.workerSymbol}`;
        upsertNode(nodes, workerId, 'worker', p.workerSymbol, ev.id);
        addEdge(edges, 'consumes', queueId, workerId, ev.id);
      }
      return;
    }

    case 'queue-state': {
      const p = ev.payload as QueueStatePayload;
      const qName = p.queueName ?? ev.links.queueName;
      if (!qName) return;
      const queueId = `queue:${qName}`;
      upsertNode(nodes, queueId, 'queue', qName, ev.id);
      addEdge(edges, 'observed_in', evId, queueId, ev.id);
      return;
    }

    case 'log': {
      const p = ev.payload as LogPayload;
      for (const svc of p.services ?? []) {
        const serviceId = `service:${svc}`;
        upsertNode(nodes, serviceId, 'service', svc, ev.id);
        addEdge(edges, 'observed_in', evId, serviceId, ev.id);
      }
      return;
    }

    case 'state': {
      const p = ev.payload as StatePayload;
      if (!p.collection) return;
      const collectionId = `collection:${p.collection}`;
      upsertNode(nodes, collectionId, 'collection', p.collection, ev.id);
      addEdge(edges, 'observed_in', evId, collectionId, ev.id);
      return;
    }

    case 'commit': {
      const deployId = `deployment:${ev.id}`;
      upsertNode(nodes, deployId, 'deployment', ev.title, ev.id);
      addEdge(edges, 'observed_in', evId, deployId, ev.id);
      return;
    }

    // symbol, flow, impact, redis-key, metric: evidence node only, no infra derived
    default:
      return;
  }
}

// ── Implication scoring ────────────────────────────────────────────────────────

/**
 * Fraction of a node's implication score to propagate to direct neighbours.
 * 0.7 means a node adjacent to a fully-implicated node receives score ≥ 0.7,
 * which clears the 0.6 threshold and marks it as implicated too.
 */
const PROPAGATION_FACTOR = 0.7;

/** Minimum implication score for a node to be marked `implicated: true`. */
const IMPLICATION_THRESHOLD = 0.6;

/**
 * Kinds that the normalization layer always classifies as `priority: 'info'`.
 * Structural evidence provides topology context, not anomaly signals — it must
 * not implicate infrastructure nodes on its own.
 */
const STRUCTURAL_KINDS: ReadonlySet<string> = new Set([
  'symbol', 'flow', 'impact', 'queue-edge',
]);

/**
 * Return true when evidence should be excluded from implication scoring.
 *
 * When evidence has been through `normalizeEvidence()` (i.e. priority is set),
 * `priority === 'info'` is the authoritative signal — it covers structural kinds,
 * low-relevance commits, and healthy snapshots. When evidence is un-normalized
 * (tests, fixtures), fall back to the structural-kind set so the guard still
 * fires for the kinds that would always receive `priority: 'info'`.
 */
function isStructuralEvidence(ev: Evidence): boolean {
  if (ev.priority !== undefined) return ev.priority === 'info';
  return STRUCTURAL_KINDS.has(ev.kind);
}

function scoreImplication(nodes: NodeMap, edges: EdgeMap, evidence: Evidence[]): void {
  const evById = new Map(evidence.map((e) => [e.id, e]));

  // Pass 1: base score = max relevance of non-structural, directly-attached
  // evidence. Structural evidence (queue-edge, symbol, flow, impact — always
  // priority: 'info') is excluded so topology alone cannot implicate a node.
  for (const node of nodes.values()) {
    if (node.type === 'evidence') continue;
    node.implicationScore = node.evidenceIds.reduce((max, eid) => {
      const ev = evById.get(eid);
      if (!ev || isStructuralEvidence(ev)) return max;
      return Math.max(max, ev.relevance);
    }, 0);
  }

  // Pass 2: propagate one hop to infrastructure neighbours (bidirectional).
  // Build adjacency ignoring observed_in edges — those connect evidence to
  // infrastructure; we only propagate between infrastructure nodes.
  const adj = new Map<string, Set<string>>();
  for (const edge of edges.values()) {
    if (edge.type === 'observed_in') continue;
    const f = nodes.get(edge.from);
    const t = nodes.get(edge.to);
    if (!f || !t || f.type === 'evidence' || t.type === 'evidence') continue;
    const fs = adj.get(edge.from) ?? new Set<string>();
    const ts = adj.get(edge.to) ?? new Set<string>();
    fs.add(edge.to);
    ts.add(edge.from); // propagate in both directions
    adj.set(edge.from, fs);
    adj.set(edge.to, ts);
  }

  // Collect all propagated scores before applying any, so a score updated by
  // propagation cannot cascade to further neighbours in the same pass.
  // This guarantees exactly one hop — not multi-hop chains.
  const toPropagate = new Map<string, number>();
  for (const [nodeId, neighbours] of adj) {
    const node = nodes.get(nodeId);
    if (!node) continue;
    const propagated = node.implicationScore * PROPAGATION_FACTOR;
    if (propagated <= 0) continue;
    for (const nid of neighbours) {
      const current = toPropagate.get(nid) ?? 0;
      if (propagated > current) toPropagate.set(nid, propagated);
    }
  }
  for (const [nid, score] of toPropagate) {
    const node = nodes.get(nid);
    if (node && score > node.implicationScore) node.implicationScore = score;
  }

  // Pass 3: set implicated flag based on final score.
  for (const node of nodes.values()) {
    if (node.type === 'evidence') continue;
    node.implicated = node.implicationScore >= IMPLICATION_THRESHOLD;
  }
}

// ── Serialization ──────────────────────────────────────────────────────────────

/** Sort nodes and edges by id and sort evidenceIds within each, for determinism. */
function finalize(nodes: NodeMap, edges: EdgeMap): InvestigationGraph {
  const sortedNodes = [...nodes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({ ...n, evidenceIds: [...n.evidenceIds].sort() }));
  const sortedEdges = [...edges.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({ ...e, evidenceIds: [...e.evidenceIds].sort() }));
  return { nodes: sortedNodes, edges: sortedEdges };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build a deterministic investigation graph from normalized evidence.
 *
 * Evidence items are processed in id order to guarantee stable output.
 * Infrastructure nodes (queue, service, worker, collection, deployment) are
 * derived from evidence content; each evidence item also becomes an `evidence`
 * node connected to its infrastructure counterparts via `observed_in` edges.
 *
 * After construction, implication scores are propagated one hop so that a
 * blocked queue or failing service marks its producer/consumer as implicated.
 */
export function buildGraph(evidence: Evidence[]): InvestigationGraph {
  const nodes: NodeMap = new Map();
  const edges: EdgeMap = new Map();

  const sorted = [...evidence].sort((a, b) => a.id.localeCompare(b.id));
  for (const ev of sorted) {
    processEvidence(ev, nodes, edges);
  }

  scoreImplication(nodes, edges, evidence);
  return finalize(nodes, edges);
}

/**
 * Return the maximum implication score among all infrastructure nodes that
 * have any of `evidenceIds` in their `.evidenceIds` list.
 *
 * Used by the engine to compute a score boost for a suspected cause: a cause
 * whose evidence directly created an implicated infrastructure node (queue,
 * service, collection) warrants a higher base score.
 */
export function maxImplicationScore(
  graph: InvestigationGraph,
  evidenceIds: string[],
): number {
  const idSet = new Set(evidenceIds);
  return graph.nodes.reduce((max, node) => {
    if (node.type === 'evidence') return max;
    return node.evidenceIds.some((eid) => idSet.has(eid))
      ? Math.max(max, node.implicationScore)
      : max;
  }, 0);
}
