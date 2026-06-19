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
