import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CloudClient } from "./api.js";
import {
  uploadInvestigationToCloud,
  fetchInvestigationReportFromCloud,
  listCloudInvestigations,
} from "./investigation-sync.js";
import type { CloudConfig } from "./context-store.js";
import type { InvestigationReport } from "@horus/engine";

const API = "https://api.test";

function makeReport(overrides?: Partial<InvestigationReport>): InvestigationReport {
  return {
    id: "rep-1",
    input: { hint: "test hint", repo: "horus", since: undefined, service: undefined },
    summary: "test summary",
    seeds: [],
    evidence: [],
    timeline: { events: [] },
    correlation: { pairs: [] },
    findings: [],
    suspectedCauses: [],
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: { gaps: [], confidenceImpact: 0 },
    graph: { nodes: [], edges: [] },
    confidence: 0.8,
    nextActions: [],
    ...overrides,
  } as InvestigationReport;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("investigation-sync", () => {
  let client: CloudClient;
  let cfg: CloudConfig;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";

      if (u.endsWith("/investigations") && method === "POST") {
        return json({
          id: "inv-1",
          projectId: "p1",
          workspaceId: "w1",
          organizationId: "o1",
          title: "test hint",
          hint: "test hint",
          status: "running",
          idempotencyKey: "rep-1:investigation",
          createdAt: "2026-06-18T10:00:00.000Z",
          updatedAt: "2026-06-18T10:00:00.000Z",
        });
      }
      if (u.includes("/investigations/") && u.endsWith("/evidence") && method === "POST") {
        return json({ id: "ev-1" });
      }
      if (u.includes("/investigations/") && u.endsWith("/agent-runs") && method === "POST") {
        return json({ id: "run-1" });
      }
      if (u.includes("/investigations/") && method === "PATCH") {
        return json({ id: "inv-1", status: "completed" });
      }
      if (u.includes("/investigations/") && u.endsWith("/evidence") && method === "GET") {
        return json([
          {
            id: "ev-1",
            investigationId: "inv-1",
            projectId: "p1",
            organizationId: "o1",
            type: "note",
            source: "cli",
            title: "Investigation report snapshot",
            content: JSON.stringify({ id: "rep-1", summary: "from cloud" }),
            contentFormat: "application/json",
            payload: { kind: "horus:report", report: { id: "rep-1", summary: "from cloud" } },
            idempotencyKey: "rep-1:report",
            createdAt: "2026-06-18T10:00:00.000Z",
          },
        ]);
      }
      if (u.includes("/investigations/") && method === "GET") {
        return json({
          id: "inv-1",
          projectId: "p1",
          workspaceId: "w1",
          organizationId: "o1",
          title: "test hint",
          hint: "test hint",
          status: "completed",
          idempotencyKey: null,
          createdAt: "2026-06-18T10:00:00.000Z",
          updatedAt: "2026-06-18T10:00:00.000Z",
          repositoryIds: ["r1"],
        });
      }
      if (u.endsWith("/investigations") && method === "GET") {
        // Cloud list endpoint returns a paginated object (HOR-244), not an array.
        return json({
          investigations: [
            {
              id: "inv-1",
              projectId: "p1",
              workspaceId: "w1",
              organizationId: "o1",
              title: "test hint",
              hint: "test hint",
              status: "completed",
              idempotencyKey: null,
              createdAt: "2026-06-18T10:00:00.000Z",
              updatedAt: "2026-06-18T10:00:00.000Z",
            },
          ],
          nextCursor: undefined,
        });
      }
      return json({ error: { code: "not_found", message: "no route" } }, 404);
    });
    vi.stubGlobal("fetch", fetchSpy);

    client = new CloudClient(API, "token");
    cfg = {
      context: "cloud",
      organization: { id: "o1", slug: "meritt-dev" },
      workspace: { id: "w1", slug: "internal-products" },
      project: { id: "p1", slug: "horus" },
      repository: { id: "r1", slug: "horus" },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads a report snapshot to cloud", async () => {
    const report = makeReport();
    const refs = await uploadInvestigationToCloud(client, cfg, report);
    expect(refs).toEqual({ projectId: "p1", investigationId: "inv-1" });

    const createInvestigation = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).endsWith("/investigations") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(createInvestigation).toBeDefined();
    expect(JSON.parse((createInvestigation![1] as RequestInit).body as string)).toMatchObject({
      title: "test hint",
      hint: "test hint",
      repositoryIds: ["r1"],
      idempotencyKey: "rep-1:investigation",
    });

    const createEvidence = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/evidence") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(createEvidence).toBeDefined();
    const evidenceBody = JSON.parse((createEvidence![1] as RequestInit).body as string);
    // Must satisfy the cloud createEvidenceSchema: valid enum type + required fields.
    expect(["code_snippet", "log", "db_result", "runtime_evidence", "file_reference", "command_output", "note"]).toContain(evidenceBody.type);
    expect(evidenceBody.source).toBe("cli");
    expect(evidenceBody.title).toBeTruthy();
    expect(evidenceBody.contentFormat).toBe("application/json");
    expect(JSON.parse(evidenceBody.content).id).toBe("rep-1");
    expect(evidenceBody.payload.report.id).toBe("rep-1");

    const createRun = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/agent-runs") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(createRun).toBeDefined();
    expect(JSON.parse((createRun![1] as RequestInit).body as string)).toMatchObject({
      repositoryId: "r1",
      status: "completed",
      summary: "test summary",
    });

    const update = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/investigations/") && (c[1] as RequestInit)?.method === "PATCH",
    );
    expect(update).toBeDefined();
    expect(JSON.parse((update![1] as RequestInit).body as string)).toEqual({ status: "completed" });
  });

  it("fetches a saved cloud report from evidence", async () => {
    const report = await fetchInvestigationReportFromCloud(client, cfg, "inv-1");
    expect(report).not.toBeNull();
    expect(report?.id).toBe("rep-1");
    expect(report?.summary).toBe("from cloud");

    const detailCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).endsWith("/investigations/inv-1") && (c[1] as RequestInit)?.method === "GET",
    );
    expect(detailCall).toBeDefined();
  });

  it("lists cloud investigations", async () => {
    const rows = await listCloudInvestigations(client, cfg);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("inv-1");
  });
});
