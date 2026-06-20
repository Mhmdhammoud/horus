/**
 * Git remote detection — a discovery aid for `horus cloud link` (HOR-238 §7).
 * Used only to suggest a repository name; never authoritative.
 */
import { execFileSync } from "node:child_process";

export interface GitRemote {
  remoteUrl: string;
  /** Bare repo name, e.g. `horus-cli` from `git@github.com:meritt-dev/horus-cli.git`. */
  repoName: string;
}

/** Parses the trailing repo name out of an SSH or HTTPS git remote URL. */
export function parseRepoName(remoteUrl: string): string {
  const cleaned = remoteUrl.trim().replace(/\.git$/, "");
  const lastSegment = cleaned.split(/[/:]/).filter(Boolean).pop() ?? "";
  return lastSegment;
}

/**
 * Canonical form of a git remote for equality, so the SSH and HTTPS forms of the
 * same repo match: `git@github.com:Org/Repo.git` and
 * `https://github.com/Org/Repo` both become `github.com/org/repo` (HOR-307).
 */
export function normalizeRemote(remoteUrl: string): string {
  let s = remoteUrl.trim().replace(/\.git$/, "");
  s = s.replace(/^[a-z]+:\/\//i, ""); // drop scheme (https://, ssh://)
  s = s.replace(/^[^@/]+@/, ""); // drop user@ (git@)
  s = s.replace(":", "/"); // scp-style host:path → host/path
  return s.replace(/\/+$/, "").toLowerCase();
}

/** True when two remotes point at the same repository (scheme/auth-insensitive). */
export function remotesMatch(a: string, b: string): boolean {
  return normalizeRemote(a) === normalizeRemote(b);
}

/** Infers the cloud `provider` value from a remote host. */
export function inferProvider(remoteUrl: string): "github" | "gitlab" | "other" {
  const host = normalizeRemote(remoteUrl).split("/")[0] ?? "";
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return "other";
}

export function detectGitRemote(root: string): GitRemote | null {
  try {
    const remoteUrl = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!remoteUrl) return null;
    return { remoteUrl, repoName: parseRepoName(remoteUrl) };
  } catch {
    return null;
  }
}
