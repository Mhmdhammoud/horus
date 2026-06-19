/**
 * Filesystem locations for Horus Cloud CLI state (HOR-226, per HOR-225 / HOR-238).
 *
 * Two stores, deliberately separated:
 *   - Repo context  → `<repo>/.horus/cloud.json`  — IDs + slugs only, safe to commit.
 *   - Auth token    → `~/.horus/auth.json`         — the secret, NEVER in the repo.
 *
 * Matches the existing `.horus/` directory convention (HOR-37 `discovery.ts`,
 * `HORUS_DIR`). The HOR-225 spec sketched `.horus` as a single file; we store the
 * cloud context as `.horus/cloud.json` to coexist with `.horus/config.json`.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { HORUS_DIR } from "@horus/core";

export const CLOUD_CONFIG_FILE = "cloud.json";
export const AUTH_FILE = "auth.json";

/** Repo-level cloud context file: `<root>/.horus/cloud.json`. */
export function cloudConfigPath(root: string): string {
  return join(root, HORUS_DIR, CLOUD_CONFIG_FILE);
}

/**
 * Global Horus home (`~/.horus`), overridable via `HORUS_HOME` for tests and
 * non-standard setups.
 */
export function horusHome(): string {
  return process.env.HORUS_HOME ?? join(homedir(), HORUS_DIR);
}

/** Global auth file holding the CLI token: `~/.horus/auth.json`. */
export function authPath(): string {
  return join(horusHome(), AUTH_FILE);
}
