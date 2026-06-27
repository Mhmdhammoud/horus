/**
 * `horus hosts` — list running source-intelligence hosts across all registered projects (HOR-41),
 * and surface/reap ORPHANED hosts that no registered repo owns (HOR-364).
 */

import pc from 'picocolors';
import { readRegistry } from '@horus/core';
import {
  readSourceHostUrl,
  isHostHealthy,
  readSourceHostPid,
  readSpawnedHost,
} from '@horus/connectors';
import { listRunningSourceHosts, selectOrphans, reapPid } from '../lib/host-reaper.js';

export async function runHosts(opts: { reap?: boolean } = {}): Promise<number> {
  const registry = readRegistry();
  const projects = Object.entries(registry.projects);

  // ── Registered hosts ────────────────────────────────────────────────────
  const rows: Array<{ name: string; hostUrl: string | null; healthy: boolean; root: string }> = [];
  await Promise.all(
    projects.map(async ([name, entry]) => {
      const hostUrl = readSourceHostUrl(entry.root);
      const healthy = hostUrl ? await isHostHealthy(hostUrl) : false;
      rows.push({ name, hostUrl: hostUrl ?? null, healthy, root: entry.root });
    }),
  );
  rows.sort((a, b) =>
    a.healthy !== b.healthy ? (a.healthy ? -1 : 1) : a.name.localeCompare(b.name),
  );

  console.log('');
  let printedAny = false;
  for (const row of rows) {
    if (row.hostUrl === null) continue;
    printedAny = true;
    const status = row.healthy ? pc.green('● running') : pc.red('● stopped');
    const port = extractPort(row.hostUrl) ?? '?';
    console.log(
      `  ${status}  ${pc.bold(row.name.padEnd(24))} port ${String(port).padEnd(6)} ${pc.dim(row.root)}`,
    );
  }
  const noHost = rows.filter((r) => r.hostUrl === null);
  for (const row of noHost) console.log(`  ${pc.dim('○ no host')}   ${pc.dim(row.name)}`);
  if (printedAny || noHost.length > 0) console.log('');

  // ── Orphan detection + reap (HOR-364) ────────────────────────────────────
  // A running `horus-source host` whose pid no registered repo records (crashed/restarted
  // host, unregistered repo, or a duplicate on an already-claimed port) is an orphan.
  const claimedPids = new Set<number>();
  for (const [, entry] of projects) {
    const hp = readSourceHostPid(entry.root);
    if (hp?.pid) claimedPids.add(hp.pid);
    const sp = readSpawnedHost(entry.root);
    if (sp?.pid) claimedPids.add(sp.pid);
  }
  const orphans = selectOrphans(await listRunningSourceHosts(), claimedPids);

  let reapFailed = 0;
  if (orphans.length > 0) {
    console.log(
      pc.yellow(`  ⚠ ${orphans.length} orphaned source host(s) — no registered repo owns them:`),
    );
    for (const o of orphans) console.log(pc.dim(`      pid ${o.pid}  port ${o.port}`));
    if (opts.reap) {
      let reaped = 0;
      for (const o of orphans) {
        if (await reapPid(o.pid)) {
          reaped++;
          console.log(`  ${pc.green('✓')} reaped pid ${o.pid} ${pc.dim(`(port ${o.port})`)}`);
        } else {
          reapFailed++;
          console.log(pc.red(`  ✗ could not stop pid ${o.pid} (port ${o.port})`));
        }
      }
      console.log(pc.dim(`  Reaped ${reaped}/${orphans.length} orphan(s).`));
    } else {
      console.log(pc.dim('  Run `horus hosts --reap` to stop them.'));
    }
    console.log('');
  }

  if (projects.length === 0 && orphans.length === 0) {
    console.log(pc.dim('No registered projects. Run `horus index` in a repo first.'));
    return 0;
  }
  if (!printedAny && orphans.length === 0) {
    console.log(pc.dim('No source-intelligence hosts found. Run `horus index` to start one.'));
    return 0;
  }

  const running = rows.filter((r) => r.healthy).length;
  console.log(
    pc.dim(
      `${running} running${orphans.length ? ` · ${orphans.length} orphan(s)` : ''} · ` +
        `horus hosts --reap to clear orphans · horus stop --all to stop everything`,
    ),
  );
  return reapFailed > 0 ? 1 : 0;
}

function extractPort(hostUrl: string): number | null {
  try {
    const p = parseInt(new URL(hostUrl).port, 10);
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}
