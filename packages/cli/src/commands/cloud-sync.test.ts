import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the local DB layer so the command's source data is controllable and no
// real Postgres is needed.
const h = vi.hoisted(() => ({ rows: [] as Array<{ id: string; title: string | null; report: unknown }> }));
vi.mock("@horus/db", () => ({
  createDb: () => ({ db: {}, sql: { end: async () => {} } }),
  listInvestigationsWithReports: async () => h.rows,
  assertLocalDatabaseUrl: () => {},
}));

import { runCloudSync } from "./cloud.js";
import { writeAuth } from "../lib/cloud/auth-store.js";
import { writeCloudConfig } from "../lib/cloud/context-store.js";

const API = "https://api.test";

function makeReport(id: string) {
  return { id, input: { hint: "slow indexing" }, summary: "summary text" };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function cloudFetch() {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const method = init?.method ?? "GET";
    if (u.endsWith("/investigations") && method === "POST") {
      return json({ id: "inv-1", projectId: "p1", status: "running", idempotencyKey: null });
    }
    if (u.includes("/evidence") && method === "POST") return json({ id: "ev-1" });
    if (u.includes("/agent-runs") && method === "POST") return json({ id: "run-1" });
    if (u.includes("/investigations/") && method === "PATCH") return json({ id: "inv-1", status: "completed" });
    return json({ error: { code: "not_found", message: "no route" } }, 404);
  });
}

let home: string;
let repo: string;
let fetchSpy: ReturnType<typeof cloudFetch>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "horus-home-"));
  repo = mkdtempSync(join(tmpdir(), "horus-repo-"));
  process.env.HORUS_HOME = home;
  process.env.HORUS_CLOUD_API_URL = API;
  fetchSpy = cloudFetch();
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.rows = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  delete process.env.HORUS_HOME;
  delete process.env.HORUS_CLOUD_API_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function linkCloud() {
  writeAuth({ apiBaseUrl: API, token: "good-token", account: { userId: "u1", email: "dev@meritt.dev" } });
  writeCloudConfig(repo, {
    context: "cloud",
    organization: { id: "o1", slug: "meritt-dev" },
    workspace: { id: "w1", slug: "internal-products" },
    project: { id: "p1", slug: "horus" },
    repository: { id: "r1", slug: "horus" },
  });
}

const postedInvestigations = () =>
  fetchSpy.mock.calls.filter(
    (c: unknown[]) => (c[0] as string).endsWith("/investigations") && (c[1] as RequestInit)?.method === "POST",
  ).length;

describe("HOR-240 cloud sync", () => {
  it("uploads local investigations that have a report; skips those without", async () => {
    linkCloud();
    h.rows = [
      { id: "loc-1", title: "slow indexing", report: makeReport("loc-1") },
      { id: "loc-2", title: "no report", report: null },
    ];

    const code = await runCloudSync({ yes: true, cwd: repo });
    expect(code).toBe(0);
    expect(postedInvestigations()).toBe(1); // only loc-1 (loc-2 has no report)
  });

  it("dry-run previews without uploading", async () => {
    linkCloud();
    h.rows = [{ id: "loc-1", title: "x", report: makeReport("loc-1") }];

    const code = await runCloudSync({ dryRun: true, cwd: repo });
    expect(code).toBe(0);
    expect(postedInvestigations()).toBe(0);
  });

  it("fails when the repo isn't linked to cloud", async () => {
    writeAuth({ apiBaseUrl: API, token: "good-token", account: { userId: "u1", email: "x" } });
    writeCloudConfig(repo, { context: "local" });
    const code = await runCloudSync({ yes: true, cwd: repo });
    expect(code).toBe(1);
    expect(postedInvestigations()).toBe(0);
  });

  it("requires login", async () => {
    writeCloudConfig(repo, {
      context: "cloud",
      organization: { id: "o1", slug: "meritt-dev" },
      workspace: { id: "w1", slug: "internal-products" },
      project: { id: "p1", slug: "horus" },
    });
    const code = await runCloudSync({ yes: true, cwd: repo });
    expect(code).toBe(1);
  });

  it("reports nothing to upload when there are no reports", async () => {
    linkCloud();
    h.rows = [{ id: "loc-1", title: "x", report: null }];
    const code = await runCloudSync({ yes: true, cwd: repo });
    expect(code).toBe(0);
    expect(postedInvestigations()).toBe(0);
  });
});
