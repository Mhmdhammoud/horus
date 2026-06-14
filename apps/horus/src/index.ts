/**
 * Composition root. Wires the CLI to the engine, connectors, and db as those phases
 * land. For HOR-1 it simply delegates to the CLI program.
 */
import { run } from '@horus/cli';

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
