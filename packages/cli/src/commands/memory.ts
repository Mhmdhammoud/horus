/**
 * HOR — `horus memory show <scope>`: a read-only synthesis of the deterministic incident
 * memory + code-knowledge graph for a scope. NO new schema, NO writes — every section reads
 * from a store that already exists (see buildMemoryView in @horus/engine).
 *
 * Memory is project-isolated (HOR-46): an unresolved project is an ERROR here, not a silent
 * unscoped run (unlike `architecture`, which swallows the throw to stay unscoped). createConnectors
 * IS required — the structural sections need the source-graph host (the table-only drizzle shortcut
 * cannot produce owned areas / runtime paths / externals / weak spots).
 */

import pc from 'picocolors';
import { loadConfig, resolveEnvironment, findRepoRoot } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { openDb } from '@horus/db';
import { buildMemoryView, renderMemoryView, memoryViewToJSON } from '@horus/engine';

export async function runMemoryShow(
  scope: string,
  opts: {
    config?: string;
    repo?: string;
    json?: boolean;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    // Memory is project-isolated (HOR-46): unresolved project is an ERROR, not silent-unscoped.
    let project: string | undefined;
    try {
      project = resolveEnvironment(config, { project: opts.repo }).project;
    } catch {
      /* unresolvable — handled below as a hard error */
    }
    if (!project) {
      console.error(
        pc.red('Could not resolve a project — pass --repo <name> or run inside a repo.'),
      );
      return 1;
    }

    const { code } = createConnectors(config);
    const repoPath = findRepoRoot(process.cwd()) ?? process.cwd();

    const { db, sql } = await openDb(config.database.url);
    try {
      const view = await buildMemoryView(scope, { code, db, repoPath, project });
      if (opts.json) {
        console.log(memoryViewToJSON(view));
      } else {
        console.log(renderMemoryView(view));
      }
      return 0;
    } finally {
      // Always close the pool (mirror architecture.ts).
      await sql.end();
    }
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
