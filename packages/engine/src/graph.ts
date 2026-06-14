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
