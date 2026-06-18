/**
 * `horus cloud link` / `unlink` / `status` (HOR-226, per HOR-225).
 *
 * Links the current repo to a cloud project so investigations are stored in
 * Horus Cloud. Git remote detection is a discovery aid only (HOR-238 §7); the
 * `.horus/cloud.json` binding is authoritative and carries no secrets.
 */
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import type { ContextResponse } from "../lib/cloud/api.js";
import {
  readCloudConfig,
  writeCloudConfig,
  clearCloudConfig,
  isCloudActive,
} from "../lib/cloud/context-store.js";
import { detectGitRemote } from "../lib/cloud/git.js";
import { authedClient, repoRootOrCwd } from "../lib/cloud/session.js";
import { resolveTriple, reportCloudError } from "./context.js";
import { createDb, listInvestigationsWithReports } from "@horus/db";
import type { InvestigationReport } from "@horus/engine";
import { resolveDbUrl } from "../lib/db-url.js";
import { uploadInvestigationToCloud } from "../lib/cloud/investigation-sync.js";

export async function runCloudLink(
  opts: { project?: string; yes?: boolean; cwd?: string } = {},
): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const session = authedClient();
  if (!session) {
    console.error(pc.red(`Not logged in. Run ${pc.bold("horus login")} first.`));
    return 1;
  }

  let ctx: ContextResponse;
  try {
    ctx = await session.client.context();
  } catch (err) {
    return reportCloudError(err);
  }

  const remote = detectGitRemote(root);
  if (remote) console.log(pc.dim(`Detected git remote: ${remote.remoteUrl}`));

  // Resolve the target project: explicit flag → existing cloud binding → prompt.
  let target = opts.project;
  if (!target) {
    const existing = readCloudConfig(root);
    if (isCloudActive(existing) && existing?.organization && existing?.workspace && existing?.project) {
      target = `${existing.organization.slug}/${existing.workspace.slug}/${existing.project.slug}`;
    }
  }
  if (!target) {
    target = await pickProjectInteractively(ctx);
  }
  if (!target) {
    console.error(
      pc.red("No project specified.") +
        `\n  Pass ${pc.bold("--project <org/workspace/project>")}, or run ${pc.bold("horus context list")} to see options.`,
    );
    return 1;
  }

  const resolved = resolveTriple(ctx, target);
  if (!resolved) {
    console.error(
      pc.red(`You don't have access to ${pc.bold(target)}.`) +
        `\n  Run ${pc.bold("horus context list")} to see available projects.`,
    );
    return 1;
  }

  const repoSlug = remote?.repoName ?? resolved.project.slug;

  // Register the repository server-side if the endpoint exists (best-effort).
  let repositoryId: string | undefined;
  try {
    const created = await session.client.createRepository(resolved.project.id, {
      slug: repoSlug,
      name: repoSlug,
      remoteUrl: remote?.remoteUrl,
    });
    repositoryId = created?.id;
  } catch (err) {
    return reportCloudError(err);
  }

  writeCloudConfig(root, {
    context: "cloud",
    organization: resolved.organization,
    workspace: resolved.workspace,
    project: resolved.project,
    repository: { id: repositoryId, slug: repoSlug },
  });

  console.log(
    `${pc.green("✓")} Linked. Context for this repo is now ${pc.bold(target)} ${pc.dim("(cloud)")}.`,
  );
  console.log(
    pc.dim(`  Investigations here save to Horus Cloud. ${pc.bold("horus context use local")} to switch back.`),
  );
  return 0;
}

export async function runCloudUnlink(opts: { cwd?: string } = {}): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const cfg = readCloudConfig(root);
  if (!cfg || cfg.context !== "cloud") {
    console.log(pc.dim("This repo isn't linked to a cloud project."));
    return 0;
  }
  clearCloudConfig(root);
  console.log(`${pc.green("✓")} Unlinked. This repo is back to ${pc.bold("local")} mode.`);
  return 0;
}

export async function runCloudStatus(opts: { cwd?: string } = {}): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const cfg = readCloudConfig(root);
  const session = authedClient();

  if (!isCloudActive(cfg) || !cfg?.project) {
    console.log(`${pc.bold("Context:")}  local`);
    console.log(`${pc.bold("Storage:")}  local Postgres (~/.horus)`);
    console.log(
      pc.dim(`Tip:      ${pc.bold("horus login")} then ${pc.bold("horus cloud link")} to share investigations with your team.`),
    );
    return 0;
  }

  const triple = `${cfg.organization?.slug}/${cfg.workspace?.slug}/${cfg.project.slug}`;
  console.log(`${pc.bold("Context:")}     ${triple}   ${pc.dim("(cloud)")}`);

  // Enrich with names when logged in + online; fall back to slugs otherwise.
  let projectLine = `${cfg.project.slug}`;
  let account = pc.dim("not logged in");
  if (session) {
    account = session.auth.account.email;
    try {
      const ctx = await session.client.context();
      const project = ctx.projects.find((p) => p.id === cfg.project?.id);
      const ws = ctx.workspaces.find((w) => w.id === project?.workspaceId);
      const org = ctx.organizations.find((o) => o.id === project?.organizationId);
      if (project && ws && org) {
        projectLine = `${project.name}  ·  workspace ${ws.name}  ·  org ${org.name}`;
      }
    } catch {
      // offline — keep slug-only line
    }
  }
  console.log(`${pc.bold("Project:")}     ${projectLine}`);
  console.log(
    `${pc.bold("Repository:")}  ${cfg.repository?.slug ?? pc.dim("(none)")}` +
      (cfg.repository?.id ? " (linked)" : cfg.repository ? pc.dim(" (pending sync)") : ""),
  );
  console.log(`${pc.bold("Account:")}     ${account}`);
  // Sync counts arrive with cloud persistence (HOR-227); not available yet.
  console.log(`${pc.bold("Sync:")}        ${pc.dim("— (cloud persistence pending: HOR-227)")}`);
  return 0;
}

/**
 * `horus cloud sync` (HOR-240) — upload existing LOCAL investigation history to
 * the linked cloud project, through the cloud API (never the cloud DB). Only
 * investigations that have a stored report are uploadable. Retries are safe:
 * `uploadInvestigationToCloud` carries report-id-derived idempotency keys, so the
 * server dedupes. Local data is never modified.
 */
export async function runCloudSync(
  opts: { config?: string; cwd?: string; yes?: boolean; dryRun?: boolean; limit?: number } = {},
): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const cfg = readCloudConfig(root);
  if (!isCloudActive(cfg) || !cfg.project) {
    console.error(
      pc.red("This repo isn't linked to a cloud project.") +
        ` Run ${pc.bold("horus cloud link")} first.`,
    );
    return 1;
  }
  const session = authedClient();
  if (!session) {
    console.error(pc.red(`Not logged in. Run ${pc.bold("horus login")} first.`));
    return 1;
  }

  // Source: local investigations that carry a stored report (others can't be uploaded).
  const { db, sql } = createDb(await resolveDbUrl(opts.config));
  const uploadable: { id: string; title: string | null; report: InvestigationReport }[] = [];
  let skippedNoReport = 0;
  try {
    const rows = await listInvestigationsWithReports(db, opts.limit ?? 1000);
    for (const row of rows) {
      if (row.report && typeof row.report === "object") {
        uploadable.push({ id: row.id, title: row.title, report: row.report as InvestigationReport });
      } else {
        skippedNoReport++;
      }
    }
  } finally {
    await sql.end();
  }

  const target = `${cfg.organization?.slug}/${cfg.workspace?.slug}/${cfg.project.slug}`;

  if (uploadable.length === 0) {
    console.log(
      pc.dim(
        `No local investigations with reports to upload.` +
          (skippedNoReport ? ` (${skippedNoReport} without a report skipped)` : ""),
      ),
    );
    return 0;
  }

  // Preview what will be uploaded (HOR-240: show before migrating).
  console.log(pc.bold(`Will upload ${uploadable.length} investigation(s) to ${target} ${pc.dim("(cloud)")}:`));
  for (const c of uploadable.slice(0, 20)) {
    console.log(`  ${pc.dim(c.id.slice(0, 8))}  ${(c.title ?? "untitled").slice(0, 70)}`);
  }
  if (uploadable.length > 20) console.log(pc.dim(`  …and ${uploadable.length - 20} more`));
  if (skippedNoReport) console.log(pc.dim(`  (${skippedNoReport} local investigation(s) without a report will be skipped)`));

  if (opts.dryRun) {
    console.log(pc.dim("Dry run — nothing uploaded. Re-run without --dry-run to upload."));
    return 0;
  }

  // Confirm unless --yes. Non-interactive without --yes is treated as a safe stop.
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.error(
        pc.yellow(`Re-run with ${pc.bold("--yes")} to upload, or ${pc.bold("--dry-run")} to preview only.`),
      );
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`Upload ${uploadable.length} investigation(s) to ${target}? (y/N) `))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        console.log(pc.dim("Aborted. Nothing uploaded."));
        return 0;
      }
    } finally {
      rl.close();
    }
  }

  let created = 0;
  let failed = 0;
  for (const c of uploadable) {
    try {
      const refs = await uploadInvestigationToCloud(session.client, cfg, c.report);
      created++;
      console.log(`${pc.green("✓")} ${pc.dim(c.id.slice(0, 8))} → ${refs.investigationId}`);
    } catch (err) {
      failed++;
      console.error(`${pc.red("✗")} ${pc.dim(c.id.slice(0, 8))} ${(err as Error).message}`);
    }
  }

  console.log("");
  console.log(
    `${pc.bold("Sync complete:")} ${pc.green(`${created} uploaded`)}, ${skippedNoReport} skipped, ` +
      (failed ? pc.red(`${failed} failed`) : "0 failed") + ".",
  );
  console.log(
    pc.dim("Local data was not modified. Re-running is safe — duplicates are deduped by idempotency key."),
  );
  return failed > 0 ? 1 : 0;
}

async function pickProjectInteractively(ctx: ContextResponse): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const labels = ctx.projects
    .map((p) => {
      const ws = ctx.workspaces.find((w) => w.id === p.workspaceId);
      const org = ctx.organizations.find((o) => o.id === p.organizationId);
      return ws && org ? `${org.slug}/${ws.slug}/${p.slug}` : null;
    })
    .filter((x): x is string => !!x);
  if (labels.length === 0) return undefined;

  console.log("Select a project to link:");
  labels.forEach((label, i) => console.log(`  ${i + 1}) ${label}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Number: ")).trim();
    const idx = Number(answer) - 1;
    return labels[idx];
  } finally {
    rl.close();
  }
}
