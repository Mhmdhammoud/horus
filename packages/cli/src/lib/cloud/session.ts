/**
 * Shared resolution helpers for cloud commands: API base URL, repo root, and the
 * authenticated client.
 */
import { findRepoRoot } from "@horus/core";
import { CloudClient, DEFAULT_API_BASE_URL } from "./api.js";
import { readAuth, type AuthState } from "./auth-store.js";

export function resolveApiBaseUrl(explicit?: string): string {
  return (
    explicit ??
    process.env.HORUS_CLOUD_API_URL ??
    readAuth()?.apiBaseUrl ??
    DEFAULT_API_BASE_URL
  );
}

export function repoRootOrCwd(cwd = process.cwd()): string {
  return findRepoRoot(cwd) ?? cwd;
}

/** The authed client, or null when not logged in. */
export function authedClient(): { client: CloudClient; auth: AuthState } | null {
  const auth = readAuth();
  if (!auth) return null;
  return { client: new CloudClient(auth.apiBaseUrl, auth.token), auth };
}
