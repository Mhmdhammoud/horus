/**
 * `horus hosts` — list running Axon hosts across all registered projects (HOR-41).
 * Shows port, repo path, and live health status.
 */

import pc from 'picocolors';
import { readRegistry } from '@horus/core';
import { readAxonHostUrl, isHostHealthy } from '@horus/connectors';

export async function runHosts(): Promise<number> {
  const registry = readRegistry();
  const projects = Object.entries(registry.projects);

  if (projects.length === 0) {
    console.log(pc.dim('No registered projects. Run `horus index` in a repo first.'));
    return 0;
  }

  const rows: Array<{ name: string; hostUrl: string | null; healthy: boolean; root: string }> = [];

  await Promise.all(
    projects.map(async ([name, entry]) => {
      const hostUrl = readAxonHostUrl(entry.root);
      const healthy = hostUrl ? await isHostHealthy(hostUrl) : false;
      rows.push({ name, hostUrl: hostUrl ?? null, healthy, root: entry.root });
    }),
  );

  // Sort: healthy first, then by name.
  rows.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const anyHost = rows.some((r) => r.hostUrl !== null);
  if (!anyHost) {
    console.log(pc.dim('No Axon hosts found. Run `horus index` to start one.'));
    return 0;
  }

  console.log('');
  for (const row of rows) {
    if (row.hostUrl === null) continue;
    const status = row.healthy ? pc.green('● running') : pc.red('● stopped');
    const port = extractPort(row.hostUrl) ?? '?';
    console.log(
      `  ${status}  ${pc.bold(row.name.padEnd(24))} port ${String(port).padEnd(6)} ${pc.dim(row.root)}`,
    );
  }
  console.log('');

  // Also show projects with no host.
  const noHost = rows.filter((r) => r.hostUrl === null);
  if (noHost.length > 0) {
    for (const row of noHost) {
      console.log(`  ${pc.dim('○ no host')}   ${pc.dim(row.name)}`);
    }
    console.log('');
  }

  const running = rows.filter((r) => r.healthy).length;
  console.log(
    pc.dim(
      `${running} running · horus stop to reap · horus stop --all to stop everything`,
    ),
  );
  return 0;
}

function extractPort(hostUrl: string): number | null {
  try {
    const p = parseInt(new URL(hostUrl).port, 10);
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}
