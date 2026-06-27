import type { CodeProvider } from '@horus/connectors';
import { listQueueEdges, type HorusDb, type QueueEdge } from '@horus/db';

export interface Subsystem {
  name: string;
  members: number;
}

export interface AsyncBoundary {
  queueName: string;
  producers: string[];
  workers: string[];
}

export interface ExternalSystem {
  name: string;
  files: number;
}

export interface ArchitectureModel {
  nodeStats: { label: string; count: number }[];
  subsystems: Subsystem[];
  asyncBoundaries: AsyncBoundary[];
  keyFlows: string[];
  externalSystems: ExternalSystem[];
  fragile: { deadCode: number; highCouplingPairs: number };
  summary: string;
}

const EXTERNAL_MARKERS = [
  'zoho',
  'stripe',
  'prisma',
  'redis',
  'bullmq',
  'twilio',
  'sendgrid',
  'clerk',
  'pusher',
  'axios',
  'elasticsearch',
  'prometheus',
  'mongo',
  'graphql',
  // Python ecosystem (HOR-356): the markers above are Node-centric, so Python backends'
  // DB/queue/web stacks went undetected (e.g. redash's Postgres + Celery). 'mongo'/'redis'
  // already cover pymongo/redis-py by substring.
  'sqlalchemy',
  'sqlmodel',
  'psycopg',
  'celery',
  'fastapi',
  'flask',
  'django',
  'kafka',
  'boto3',
] as const;

export async function discoverArchitecture(deps: {
  code: CodeProvider;
  db: HorusDb;
  /** Active project — scopes queue edges so other projects' queues don't leak in (HOR-207). */
  project?: string;
}): Promise<ArchitectureModel> {
  // 1. Node label counts
  const nodeStats = await (async () => {
    try {
      const result = await deps.code.cypher(
        'MATCH (n) RETURN label(n), count(n) ORDER BY count(n) DESC',
      );
      return result.rows
        .map((row) => ({
          label: String(row[0] ?? ''),
          count: Number(row[1] ?? 0),
        }))
        .filter((s) => s.label !== 'Embedding');
    } catch {
      return [];
    }
  })();

  // 2. Subsystems (Louvain communities)
  const subsystems = await (async () => {
    try {
      const result = await deps.code.cypher(
        'MATCH (m)-[r:CodeRelation]->(c:Community) WHERE r.rel_type = "member_of" RETURN c.name, count(m) ORDER BY count(m) DESC',
      );
      return result.rows
        .slice(0, 12)
        .map((row) => ({
          name: String(row[0] ?? ''),
          members: Number(row[1] ?? 0),
        }));
    } catch {
      return [];
    }
  })();

  // 3. Async boundaries from queue edges
  const asyncBoundaries = await (async () => {
    try {
      const edges: QueueEdge[] = await listQueueEdges(deps.db, { project: deps.project });
      const byQueue = new Map<string, { producers: Set<string>; workers: Set<string> }>();
      for (const edge of edges) {
        const key = edge.queueName;
        if (!byQueue.has(key)) {
          byQueue.set(key, { producers: new Set(), workers: new Set() });
        }
        const entry = byQueue.get(key)!;
        if (edge.producerSymbol != null && edge.producerSymbol !== '') {
          entry.producers.add(edge.producerSymbol);
        }
        if (edge.workerSymbol != null && edge.workerSymbol !== '') {
          entry.workers.add(edge.workerSymbol);
        }
      }
      return Array.from(byQueue.entries()).map(([queueName, { producers, workers }]) => ({
        queueName,
        producers: Array.from(producers),
        workers: Array.from(workers),
      }));
    } catch {
      return [];
    }
  })();

  // 4. Key flows (Process nodes)
  const keyFlows = await (async () => {
    try {
      const result = await deps.code.cypher(
        'MATCH (p:Process) RETURN p.name ORDER BY p.name',
      );
      return result.rows.slice(0, 20).map((row) => String(row[0] ?? ''));
    } catch {
      return [];
    }
  })();

  // 5. Fragility metrics
  const deadCode = await (async () => {
    try {
      const result = await deps.code.cypher(
        'MATCH (n) WHERE n.is_dead = true RETURN count(n)',
      );
      return Number(result.rows[0]?.[0] ?? 0);
    } catch {
      return 0;
    }
  })();

  const highCouplingPairs = await (async () => {
    try {
      const result = await deps.code.cypher(
        'MATCH ()-[r:CodeRelation]->() WHERE r.rel_type = "coupled_with" AND r.co_changes >= 3 RETURN count(r)',
      );
      return Number(result.rows[0]?.[0] ?? 0);
    } catch {
      return 0;
    }
  })();

  // 6. External systems (parallel marker checks)
  const externalSystems = await (async () => {
    try {
      const results = await Promise.all(
        EXTERNAL_MARKERS.map(async (marker) => {
          try {
            const result = await deps.code.cypher(
              `MATCH (n:File) WHERE n.content CONTAINS "${marker}" RETURN count(n)`,
            );
            const count = Number(result.rows[0]?.[0] ?? 0);
            return { name: marker, files: count };
          } catch {
            return { name: marker, files: 0 };
          }
        }),
      );
      return results.filter((r) => r.files > 0).sort((a, b) => b.files - a.files);
    } catch {
      return [];
    }
  })();

  // 7. Summary sentence
  const largestSubsystem = subsystems[0];
  const largestDesc =
    largestSubsystem != null
      ? `${largestSubsystem.name} with ${largestSubsystem.members} symbols`
      : 'none';
  const summary =
    `${subsystems.length} subsystems (largest: ${largestDesc}), ` +
    `${asyncBoundaries.length} async queue boundaries, ` +
    `${externalSystems.length} external systems, ` +
    `${deadCode} unreferenced symbols.`;

  return {
    nodeStats,
    subsystems,
    asyncBoundaries,
    keyFlows,
    externalSystems,
    fragile: { deadCode, highCouplingPairs },
    summary,
  };
}
