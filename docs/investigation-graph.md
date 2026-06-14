# Investigation Graph

## What it is

`InvestigationGraph` is an in-memory, deterministic topology of the infrastructure
components implied by a set of normalized `Evidence` items. It answers the question:
_which services, queues, workers, and databases are connected to each other in this
incident?_

The graph is built automatically by the engine (`buildGraph(evidence)`) immediately
after evidence normalization, before findings or suspected causes are scored. It is
included in every `InvestigationReport` as `report.graph`.

## Why it exists

Horus collects evidence from many providers: BullMQ queue edges, Elasticsearch logs,
MongoDB collections, git commits. Without a graph, these items are a flat list. With
the graph the engine can answer structural questions:

- Which service produces jobs that flow into the stalled queue?
- Which worker consumes from that queue?
- Which MongoDB collection is the worker reading from?

The engine uses this to *boost suspected-cause scores*: when a queue or service has
high-relevance evidence attached to it, every cause that references evidence connected
to that node gets a small score bonus (up to +0.1). This breaks ties in favour of
the runtime-confirmed path over purely structural reasoning.

## Graph model

```ts
// packages/engine/src/graph.ts

type GraphNodeType =
  | 'service'         // a running software service
  | 'queue'           // a BullMQ job queue
  | 'worker'          // a queue consumer / worker process
  | 'database'        // a database server
  | 'collection'      // a MongoDB collection
  | 'deployment'      // a git commit / deployment event
  | 'evidence'        // an evidence item not mapped to infrastructure
  | 'external_system' // an external dependency
  | 'unknown';

type GraphEdgeType =
  | 'emits'           // service → queue: service enqueues jobs
  | 'consumes'        // queue → worker: worker processes jobs
  | 'writes_to'       // service/worker → collection: writes data
  | 'reads_from'      // service/worker → collection: reads data
  | 'depends_on'      // service → service: general dependency
  | 'caused_by'       // node → node: causal relationship
  | 'correlated_with' // node → node: correlation
  | 'observed_in';    // evidence → infrastructure: where evidence was seen

interface GraphNode {
  id: string;              // stable: "queue:payments", "service:api"
  type: GraphNodeType;
  label: string;
  evidenceIds: string[];   // which evidence items created or reference this node
  implicated: boolean;     // true when high-priority evidence is nearby
  implicationScore: number; // 0–1; max attached relevance, propagated one hop
}

interface GraphEdge {
  id: string;              // stable: "{from}--{type}-->{to}"
  type: GraphEdgeType;
  from: string;
  to: string;
  evidenceIds: string[];
}
```

## How evidence maps to nodes and edges

| Evidence kind | Infrastructure node | Edges created |
|---------------|---------------------|---------------|
| `queue-edge` | `queue:{queueName}`, `service:{producerSymbol}`, `worker:{workerSymbol}` | `service→queue: emits`, `queue→worker: consumes`, `ev→queue: observed_in` |
| `queue-state` | `queue:{queueName}` (upsert) | `ev→queue: observed_in` |
| `log` | `service:{name}` for each service in `payload.services` | `ev→service: observed_in` (per service) |
| `state` | `collection:{payload.collection}` | `ev→collection: observed_in` |
| `commit` | `deployment:{ev.id}` | `ev→deployment: observed_in` |
| `symbol`, `flow`, `impact`, `redis-key`, `metric` | none (evidence node only) | — |

Each evidence item also produces an `evidence` node (`ev:{ev.id}`) regardless of kind.
Evidence items that don't map cleanly to infrastructure are represented as evidence nodes
with no outgoing edges.

## Implication scoring

After the graph is built, a two-pass scoring algorithm assigns `implicationScore` and
`implicated` to every infrastructure node:

**Pass 1 — base score**: `implicationScore = max(evidence.relevance)` across all
directly-attached evidence items.

**Pass 2 — one-hop propagation**: for each infrastructure node, its score propagates
to direct neighbours at `score × 0.7`. Propagation is bidirectional: a backed-up queue
implies its producer service and its worker; a failing service implies the queue it
emits to.

**`implicated: true`** is set when `implicationScore ≥ 0.6` (the medium priority
threshold from the normalization layer).

### Example

```
service:OrderService  ──(emits)──>  queue:payments  ──(consumes)──>  worker:PaymentWorker
   score: 0.63                         score: 0.9                         score: 0.63
   implicated: true                    implicated: true                   implicated: true
```

Here `queue:payments` had a queue-state evidence item with relevance 0.9 attached.
Pass 2 propagated `0.9 × 0.7 = 0.63` to the service and worker, making all three
implicated.

## Node and edge ID stability

All IDs are content-derived — never random — so the graph output is deterministic for
the same input evidence.

| Entity | ID pattern | Example |
|--------|-----------|---------|
| Queue | `queue:{queueName}` | `queue:payments` |
| Service | `service:{symbolName}` | `service:OrderService` |
| Worker | `worker:{symbolName}` | `worker:PaymentWorker` |
| Collection | `collection:{collection}` | `collection:orders` |
| Deployment | `deployment:{ev.id}` | `deployment:abc-123-…` |
| Evidence item | `ev:{ev.id}` | `ev:abc-123-…` |
| Edge | `{from}--{type}-->{to}` | `service:OrderService--emits-->queue:payments` |

## Example: service → queue → worker → database

A real investigation might look like:

```
service:OrderService ──(emits)──> queue:order-processing
                                       │
                                  (consumes)
                                       │
                               worker:OrderWorker ──(writes_to)──> collection:orders
```

In this graph:
- `queue:order-processing` has queue-state evidence attached (backlog 4,382 jobs)
- The queue's `implicationScore` = 0.88 (from the backlog evidence relevance)
- `service:OrderService` and `worker:OrderWorker` get propagated score 0.62 → `implicated: true`
- The suspected cause for `order-processing` path gets a +0.088 score boost
- If `collection:orders` were also attached via `writes_to`, it would receive a second-hop
  propagation — but second-hop propagation is not yet implemented (single pass only)

## How to add graph metadata for a new provider

When you add a new provider, the graph picks up your evidence automatically if it uses
a standard `kind`. Check the mapping table above. If your provider needs a new node or
edge type:

1. Add the new literal to `GraphNodeType` or `GraphEdgeType` in
   `packages/engine/src/graph.ts`.
2. Add a `case` for your `kind` inside `processEvidence()` in `graph.ts`. Create
   infrastructure nodes with `upsertNode()` and edges with `addEdge()`.
3. Add a test in `packages/engine/src/graph.test.ts`.
4. Update the mapping table in this document.

The `writes_to` and `reads_from` edge types are defined but not yet emitted by any
provider — they are reserved for a future provider that knows the data flow between
services and collections.
