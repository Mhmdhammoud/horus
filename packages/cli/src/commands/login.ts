/**
 * `horus login` / `horus logout` (HOR-303, per HOR-223 §3).
 *
 * Default UX is a browser device-login: the CLI starts a session, prints a URL +
 * short code, the user approves in the browser (signed in via Clerk), and the CLI
 * polls until a Horus-issued `hct_` token is minted. The token is stored in
 * `~/.horus/auth.json` — never in the repo, never a DB credential.
 *
 * A token can still be supplied directly via `--token` or `HORUS_TOKEN` (CI and
 * machine use); that path validates against `GET /v1/me` and skips the browser.
 */
import { execFile } from "node:child_process";
import pc from "picocolors";
import { CloudClient, CloudError, CloudOfflineError } from "../lib/cloud/api.js";
import { writeAuth, readAuth, clearAuth } from "../lib/cloud/auth-store.js";
import { resolveApiBaseUrl, authedClient } from "../lib/cloud/session.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Best-effort open of a URL in the default browser. Never throws. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFile(cmd, args, () => {
      /* ignore — the URL is printed regardless */
    });
  } catch {
    /* headless / no browser — the user opens the printed URL manually */
  }
}

/** Validate a directly-supplied token (CI path) and persist it. */
async function loginWithToken(apiBaseUrl: string, token: string): Promise<number> {
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

/** Browser device-login: start a session, print the code, poll until resolved. */
async function loginWithBrowser(apiBaseUrl: string): Promise<number> {
  const client = new CloudClient(apiBaseUrl);

  let session;
  try {
    session = await client.startCliSession();
  } catch (err) {
    if (err instanceof CloudOfflineError) {
      console.error(pc.red(err.message));
      return 1;
    }
    console.error(pc.red(`Could not start login: ${(err as Error).message}`));
    return 1;
  }

  console.log("");
  console.log(`  To sign in, open this URL in your browser:`);
  console.log(`    ${pc.cyan(pc.bold(session.verificationUri))}`);
  console.log("");
  console.log(`  and enter the code:  ${pc.bold(session.userCode)}`);
  console.log("");
  console.log(pc.dim(`  Waiting for approval…  (press Ctrl+C to cancel)`));

  openBrowser(session.verificationUriComplete);

  const deadline = Date.now() + session.expiresIn * 1000;
  let intervalMs = Math.max(session.interval, 1) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let poll;
    try {
      poll = await client.pollCliSession(session.deviceCode);
    } catch (err) {
      if (err instanceof CloudOfflineError) {
        console.error(pc.red(`\n${err.message}`));
        return 1;
      }
      // Transient HTTP error — keep polling until the deadline.
      continue;
    }

    switch (poll.status) {
      case "pending":
        break;
      case "slow_down":
        intervalMs += 2000;
        break;
      case "denied":
        console.error(pc.red("\nLogin was denied in the browser."));
        return 1;
      case "expired":
        console.error(pc.red("\nThis login request expired. Run `horus login` again."));
        return 1;
      case "approved":
        if (!poll.token || !poll.account) {
          console.error(pc.red("\nLogin approved but no token was returned. Try again."));
          return 1;
        }
        writeAuth({
          apiBaseUrl,
          token: poll.token,
          account: { userId: poll.account.userId, email: poll.account.email },
        });
        console.log(
          `\n${pc.green("✓")} Logged in as ${pc.bold(poll.account.email)}. ` +
            `Run ${pc.bold("horus cloud link")} to connect this repo.`,
        );
        return 0;
    }
  }

  console.error(pc.red("\nTimed out waiting for approval. Run `horus login` again."));
  return 1;
}

export async function runLogin(opts: { token?: string; apiUrl?: string } = {}): Promise<number> {
  const apiBaseUrl = resolveApiBaseUrl(opts.apiUrl);
  const directToken = opts.token ?? process.env.HORUS_TOKEN;

  // CI / machine path: an explicit token skips the browser entirely.
  if (directToken) {
    return loginWithToken(apiBaseUrl, directToken);
  }

  // Default: browser device-login.
  return loginWithBrowser(apiBaseUrl);
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
