import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin } from "./login.js";

const API = "https://api.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Device-login fetch fake (HOR-303). `start` returns a fixed session; `poll`
 * returns successive statuses from a queue so a test can script the flow.
 */
function deviceFetch(pollQueue: Array<Record<string, unknown>>) {
  return vi.fn(async (url: string | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/v1/cli-sessions/start")) {
      return json({
        deviceCode: "dev-secret",
        userCode: "ABCD-EFGH",
        verificationUri: `${API}/device`,
        verificationUriComplete: `${API}/device?code=ABCD-EFGH`,
        expiresIn: 600,
        interval: 1,
      });
    }
    if (u.endsWith("/v1/cli-sessions/poll")) {
      return json(pollQueue.shift() ?? { status: "pending" });
    }
    return json({ error: { code: "not_found", message: "no route" } }, 404);
  });
}

let home: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "horus-login-"));
  process.env.HORUS_HOME = home;
  process.env.HORUS_CLOUD_API_URL = API;
  delete process.env.HORUS_TOKEN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
  delete process.env.HORUS_HOME;
  delete process.env.HORUS_CLOUD_API_URL;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Drive the poll loop deterministically: each real microtask flush is paired
// with advancing fake timers past the interval so the next poll fires.
async function runWithTimers(p: Promise<number>): Promise<number> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1500);
  }
  return p;
}

describe("HOR-303 device login", () => {
  it("completes the device flow and writes auth on approval", async () => {
    vi.useFakeTimers();
    globalThis.fetch = deviceFetch([
      { status: "pending" },
      { status: "approved", token: "hct_minted", account: { userId: "u1", email: "dev@meritt.dev" } },
    ]) as unknown as typeof fetch;

    const code = await runWithTimers(runLogin({ apiUrl: API }));
    expect(code).toBe(0);

    const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    expect(auth.token).toBe("hct_minted");
    expect(auth.account.email).toBe("dev@meritt.dev");
  });

  it("fails (exit 1) when the browser denies", async () => {
    vi.useFakeTimers();
    globalThis.fetch = deviceFetch([{ status: "denied" }]) as unknown as typeof fetch;

    const code = await runWithTimers(runLogin({ apiUrl: API }));
    expect(code).toBe(1);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  it("fails (exit 1) when the request expires", async () => {
    vi.useFakeTimers();
    globalThis.fetch = deviceFetch([{ status: "expired" }]) as unknown as typeof fetch;

    const code = await runWithTimers(runLogin({ apiUrl: API }));
    expect(code).toBe(1);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });
});
