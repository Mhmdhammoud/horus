/**
 * Repo cloud-context store: `<repo>/.horus/cloud.json` (HOR-225 § Config).
 *
 * Holds IDs + slugs only — never the token. Safe to commit (teams may share the
 * cloud context) or git-ignore for per-developer choice.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { cloudConfigPath } from "./paths.js";

export interface Ref {
  id: string;
  slug: string;
}

/**
 * @deprecated A project IS the repository/codebase now (HOR-280). The CLI context
 * UX no longer exposes or writes a separate Repository (HOR-278). This type is
 * retained only so the legacy investigation-sync path still type-checks; new
 * configs never populate it and `context show` / `cloud status` never display it.
 */
export interface RepositoryRef {
  id?: string;
  slug: string;
}

export interface CloudConfig {
  /** Where this repo's investigations are stored. */
  context: "local" | "cloud";
  organization?: Ref;
  workspace?: Ref;
  project?: Ref;
  /** @deprecated HOR-278 — Project is the repository. Not written by new configs. */
  repository?: RepositoryRef;
}

export function readCloudConfig(root: string): CloudConfig | null {
  const p = cloudConfigPath(root);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CloudConfig>;
    if (parsed.context !== "local" && parsed.context !== "cloud") return null;
    return parsed as CloudConfig;
  } catch {
    return null;
  }
}

export function writeCloudConfig(root: string, cfg: CloudConfig): void {
  const p = cloudConfigPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

export function clearCloudConfig(root: string): void {
  const p = cloudConfigPath(root);
  if (existsSync(p)) rmSync(p);
}

/** True when the repo is actively storing investigations in the cloud. */
export function isCloudActive(cfg: CloudConfig | null): cfg is CloudConfig {
  return !!cfg && cfg.context === "cloud" && !!cfg.project;
}
