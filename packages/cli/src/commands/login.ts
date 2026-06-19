/**
 * `horus login` / `horus logout` (HOR-226, per HOR-223 / HOR-225).
 *
 * Authentication stores a Horus-issued CLI token in `~/.horus/auth.json` — never
 * in the repo, never a DB credential. The eventual UX is a browser device-flow
 * (HOR-223 §3); that needs server device endpoints (follow-up). Until then login
 * accepts a token minted from the dashboard (`--token`, `HORUS_TOKEN`, or an
 * interactive prompt) and validates it against `GET /v1/me`.
 */
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { CloudClient, CloudError, CloudOfflineError } from "../lib/cloud/api.js";
import { writeAuth, readAuth, clearAuth } from "../lib/cloud/auth-store.js";
import { resolveApiBaseUrl, authedClient } from "../lib/cloud/session.js";

async function promptToken(): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Paste your Horus Cloud token: ");
    return answer.trim() || null;
  } finally {
    rl.close();
  }
}

export async function runLogin(opts: { token?: string; apiUrl?: string } = {}): Promise<number> {
  const apiBaseUrl = resolveApiBaseUrl(opts.apiUrl);
  const token = opts.token ?? process.env.HORUS_TOKEN ?? (await promptToken());

  if (!token) {
    console.error(
      pc.red("No token provided.") +
        "\n  Create one in the Horus Cloud dashboard, then run " +
        pc.bold("horus login --token <token>") +
        " (or set HORUS_TOKEN).",
    );
    console.error(pc.dim("  Browser device-flow login is coming once the cloud device endpoints land."));
    return 1;
  }

  const client = new CloudClient(apiBaseUrl, token);
  try {
    const me = await client.me();
    writeAuth({
      apiBaseUrl,
      token,
      account: {
        userId: me.user.id,
        email: me.user.primaryEmail,
        displayName: me.user.displayName ?? undefined,
      },
    });
    console.log(
      `${pc.green("✓")} Logged in as ${pc.bold(me.user.primaryEmail)}. ` +
        `Run ${pc.bold("horus cloud link")} to connect this repo.`,
    );
    return 0;
  } catch (err) {
    if (err instanceof CloudOfflineError) {
      console.error(pc.red(err.message));
      return 1;
    }
    if (err instanceof CloudError && err.status === 401) {
      console.error(pc.red("That token is not valid. Create a fresh one in the dashboard and try again."));
      return 1;
    }
    console.error(pc.red(`Login failed: ${(err as Error).message}`));
    return 1;
  }
}

export async function runLogout(): Promise<number> {
  const auth = readAuth();
  if (!auth) {
    console.log(pc.dim("Not logged in."));
    return 0;
  }

  // Best-effort server-side revoke of the active token (matched by prefix), so a
  // logout truly invalidates it — not just locally.
  const session = authedClient();
  if (session) {
    try {
      const prefix = auth.token.slice(0, 12);
      const { tokens } = await session.client.listTokens();
      const match = tokens.find((t) => t.prefix === prefix && !t.revokedAt);
      if (match) await session.client.revokeToken(match.id);
    } catch {
      // Offline or already-invalid token — clearing local creds is enough.
    }
  }

  clearAuth();
  console.log(`${pc.green("✓")} Logged out. Local mode still works.`);
  return 0;
}
