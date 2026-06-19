/**
 * Auth token store: `~/.horus/auth.json` (HOR-223 §4). The token is the only
 * secret the CLI holds; it never goes into the repo `.horus/` config and the CLI
 * never receives DB credentials.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { authPath, horusHome } from "./paths.js";

export interface CloudAccount {
  userId: string;
  email: string;
  displayName?: string;
}

export interface AuthState {
  apiBaseUrl: string;
  token: string;
  account: CloudAccount;
}

export function readAuth(): AuthState | null {
  const p = authPath();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<AuthState>;
    if (!parsed.token || !parsed.apiBaseUrl || !parsed.account) return null;
    return parsed as AuthState;
  } catch {
    return null;
  }
}

export function writeAuth(state: AuthState): void {
  mkdirSync(horusHome(), { recursive: true });
  const p = authPath();
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  // Tighten perms even if the file pre-existed with a looser mode.
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
}

export function clearAuth(): void {
  const p = authPath();
  if (existsSync(p)) rmSync(p);
}
