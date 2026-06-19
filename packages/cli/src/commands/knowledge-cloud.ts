/**
 * `horus knowledge push|pull` and `horus knowledge status --cloud` (HOR-296).
 *
 * OPTIONAL cloud sync for the local knowledge index. Local indexing/querying
 * (`horus index`, `horus knowledge ask`) never require this — it is gated behind
 * authenticated, cloud-linked mode and degrades to a clear message when offline
 * or unauthenticated. Uploads are content-hash idempotent (no duplicate pushes).
 * See docs/knowledge-cloud-sync.md for the model + redaction considerations.
 */
import pc from 'picocolors';
import { createJsonKnowledgeStore, KnowledgeSnapshotSchema } from '@horus/knowledge';
import { authedClient, repoRootOrCwd } from '../lib/cloud/session.js';
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';
import { CloudClient, CloudError } from '../lib/cloud/api.js';
import { reportCloudError } from './context.js';

interface CloudTarget {
  client: CloudClient;
  projectId: string;
  projectSlug: string;
  root: string;
}

type Resolved = { ok: true; target: CloudTarget } | { ok: false; code: number };

/** Resolve the authenticated client + linked cloud project, or a gated message. */
function resolveCloudTarget(cwd?: string): Resolved {
  const root = repoRootOrCwd(cwd);
  const session = authedClient();
  if (!session) {
    console.error(
      pc.red('Not logged in.') +
        ` Cloud sync is optional — run ${pc.bold('horus login')} to enable it. Local knowledge still works.`,
    );
    return { ok: false, code: 1 };
  }
  const cfg = readCloudConfig(root);
  if (!isCloudActive(cfg) || !cfg.project) {
    console.error(
      pc.red('This repo is not linked to a cloud project.') +
        ` Run ${pc.bold('horus context use <org>/<workspace>/<project>')} first.`,
    );
    return { ok: false, code: 1 };
  }
  return { ok: true, target: { client: session.client, projectId: cfg.project.id, projectSlug: cfg.project.slug, root } };
}

function localContentHash(root: string): { hash?: string; snapshot?: unknown; manifest?: ReturnType<ReturnType<typeof createJsonKnowledgeStore>['readManifest']> } {
  const store = createJsonKnowledgeStore(root);
  if (!store.exists()) return {};
  const manifest = store.readManifest();
  const snapshot = store.readSnapshot();
  const hash = manifest?.files.find((f) => f.name === 'knowledge-base.json')?.contentHash;
  return { hash, snapshot, manifest };
}

export async function runKnowledgePush(
  opts: { cwd?: string; dryRun?: boolean } = {},
): Promise<number> {
  const root0 = repoRootOrCwd(opts.cwd);
  const local = localContentHash(root0);
  if (!local.hash || !local.snapshot || !local.manifest) {
    console.error(pc.red('No local knowledge index to push.') + ` Run ${pc.bold('horus index')} first.`);
    return 1;
  }

  const t = resolveCloudTarget(opts.cwd);
  if (!t.ok) return t.code;
  const { client, projectId } = t.target;
  const manifest = local.manifest;

  // Content-hash dedup: skip when the cloud already has this exact snapshot.
  try {
    const latest = await client.getLatestKnowledgeSnapshot(projectId);
    if (latest.contentHash === local.hash) {
      console.log(pc.green('Cloud is already up to date') + pc.dim(` (${local.hash.slice(0, 8)}).`));
      return 0;
    }
  } catch (err) {
    if (!(err instanceof CloudError && err.status === 404)) return reportCloudError(err);
    // 404 → no snapshot yet; continue to push.
  }

  const total = Object.values(manifest.counts).reduce((a, b) => a + b, 0);
  if (opts.dryRun) {
    console.log(
      pc.dim(`[dry-run] would push snapshot ${local.hash.slice(0, 8)} (${total} item(s), schema v${manifest.schemaVersion}) to project ${t.target.projectSlug}.`),
    );
    return 0;
  }

  try {
    const rec = await client.pushKnowledgeSnapshot(projectId, {
      schemaVersion: manifest.schemaVersion,
      contentHash: local.hash,
      gitSha: manifest.git?.sha,
      branch: manifest.git?.branch,
      generatedAt: manifest.generatedAt,
      counts: manifest.counts,
      snapshot: local.snapshot,
      manifest,
      idempotencyKey: local.hash,
    });
    console.log(pc.green('✓ pushed knowledge snapshot') + pc.dim(` ${rec.contentHash.slice(0, 8)} → ${t.target.projectSlug} (${total} item(s))`));
    return 0;
  } catch (err) {
    return reportCloudError(err);
  }
}

export async function runKnowledgePull(
  opts: { cwd?: string; force?: boolean } = {},
): Promise<number> {
  const t = resolveCloudTarget(opts.cwd);
  if (!t.ok) return t.code;
  const { client, projectId, root } = t.target;

  let latest;
  try {
    latest = await client.getLatestKnowledgeSnapshot(projectId);
  } catch (err) {
    if (err instanceof CloudError && err.status === 404) {
      console.log(pc.yellow('No cloud knowledge snapshot for this project yet.') + ` Push one with ${pc.bold('horus knowledge push')}.`);
      return 0;
    }
    return reportCloudError(err);
  }
  if (!latest.snapshot) {
    console.error(pc.red('Cloud returned a snapshot record with no body.'));
    return 1;
  }

  const local = localContentHash(root);
  if (local.hash === latest.contentHash) {
    console.log(pc.green('Local index already matches cloud') + pc.dim(` (${latest.contentHash.slice(0, 8)}).`));
    return 0;
  }
  if (local.hash && local.hash !== latest.contentHash && !opts.force) {
    console.error(
      pc.yellow('Local index differs from the cloud snapshot.') +
        ` Re-run with ${pc.bold('--force')} to overwrite local with the cloud copy.`,
    );
    return 1;
  }

  let snapshot;
  try {
    snapshot = KnowledgeSnapshotSchema.parse(latest.snapshot);
  } catch (err) {
    console.error(pc.red(`Cloud snapshot failed validation: ${(err as Error).message}`));
    return 1;
  }
  createJsonKnowledgeStore(root).write(snapshot, {
    generator: { tool: 'horus-cloud-pull' },
    git: { sha: latest.gitSha ?? undefined, branch: latest.branch ?? undefined },
  });
  console.log(pc.green('✓ pulled knowledge snapshot') + pc.dim(` ${latest.contentHash.slice(0, 8)} ← ${t.target.projectSlug}`));
  return 0;
}

/** The `--cloud` addendum to `horus knowledge status`: compares local vs cloud. */
export async function runKnowledgeCloudStatus(opts: { cwd?: string } = {}): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const session = authedClient();
  if (!session) {
    console.log(pc.dim('Cloud: not logged in (`horus login` to enable optional cloud sync).'));
    return 0;
  }
  const cfg = readCloudConfig(root);
  if (!isCloudActive(cfg) || !cfg.project) {
    console.log(pc.dim('Cloud: this repo is not linked to a cloud project.'));
    return 0;
  }
  try {
    const latest = await session.client.getLatestKnowledgeSnapshot(cfg.project.id);
    const localHash = localContentHash(root).hash;
    const inSync = localHash !== undefined && localHash === latest.contentHash;
    console.log(pc.bold('Cloud knowledge snapshot'));
    console.log(`  project:    ${cfg.project.slug}`);
    console.log(`  cloud:      ${latest.contentHash.slice(0, 8)} @ ${(latest.gitSha ?? '—').slice(0, 8)} (${latest.generatedAt})`);
    console.log(`  local:      ${(localHash ?? '—').slice(0, 8)}`);
    console.log(
      inSync
        ? pc.green('  ✓ local matches cloud')
        : pc.yellow('  ⚠ local differs — run `horus knowledge push` or `horus knowledge pull`'),
    );
    return 0;
  } catch (err) {
    if (err instanceof CloudError && err.status === 404) {
      console.log(pc.dim('Cloud: no knowledge snapshot pushed for this project yet.'));
      return 0;
    }
    return reportCloudError(err);
  }
}
