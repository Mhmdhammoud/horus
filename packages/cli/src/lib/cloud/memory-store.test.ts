import { describe, it, expect, beforeEach, vi } from "vitest";
import { CloudClient, CloudError } from "./api.js";
import type { MemoryItemRecord, MemoryItemSyncInput, MemorySyncResult } from "./api.js";
import { createCloudMemoryStore, dualWriteMemoryStore } from "./memory-store.js";
import type { CloudConfig } from "./context-store.js";
import type { AuditCtx, NewMemoryItem, MemoryStore } from "@horus/engine";

const CFG: CloudConfig = {
  context: "cloud",
  organization: { id: "org-1", slug: "acme" },
  workspace: { id: "ws-1", slug: "platform" },
  project: { id: "proj-1", slug: "horus" },
};

const AUDIT: AuditCtx = { actor: { kind: "user", id: "u1" } };

function record(over: Partial<MemoryItemRecord> & { clientId: string }): MemoryItemRecord {
  return {
    id: `cloud-${over.clientId}`,
    organizationId: "org-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    createdByUserId: "u1",
    visibility: "private",
    kind: "decision",
    claim: "use ULID for ids",
    scope: "repo",
    source: "human",
    status: "fresh",
    confidence: 0.75,
    lastVerifiedAt: null,
    lastVerifiedHash: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

/** A CloudClient with syncMemoryItems/listMemoryItems stubbed; the real `request` never runs. */
function mockClient(over?: {
  sync?: (projectId: string, body: { items: MemoryItemSyncInput[] }) => Promise<MemorySyncResult>;
  list?: (projectId: string, q?: unknown) => Promise<{ items: MemoryItemRecord[]; nextCursor?: string }>;
}) {
  const sync = vi.fn(
    over?.sync ??
      (async (_p: string, body: { items: MemoryItemSyncInput[] }) => ({
        items: body.items.map((i) => record({ ...i })),
      })),
  );
  const list = vi.fn(over?.list ?? (async () => ({ items: [] as MemoryItemRecord[] })));
  const client = { syncMemoryItems: sync, listMemoryItems: list } as unknown as CloudClient;
  return { client, sync, list };
}

function newItem(over?: Partial<NewMemoryItem>): NewMemoryItem {
  return {
    id: "01JADD",
    kind: "decision",
    claim: "use ULID for ids",
    scope: "repo",
    source: "human",
    confidence: 0.75,
    repo: "horus",
    ...over,
  } as NewMemoryItem;
}

describe("createCloudMemoryStore", () => {
  let client: CloudClient;
  let sync: ReturnType<typeof vi.fn>;
  let list: ReturnType<typeof vi.fn>;
  let store: MemoryStore;

  beforeEach(() => {
    const m = mockClient();
    client = m.client;
    sync = m.sync;
    list = m.list;
    store = createCloudMemoryStore(client, CFG);
  });

  it("requires a linked cloud project", () => {
    expect(() => createCloudMemoryStore(client, { context: "cloud" })).toThrow(/linked cloud project/);
  });

  it("add() upserts via syncMemoryItems and returns the local ULID as the item id", async () => {
    const row = await store.add(newItem(), AUDIT);
    expect(sync).toHaveBeenCalledWith("proj-1", { items: [expect.objectContaining({ clientId: "01JADD" })] });
    expect(row.id).toBe("01JADD"); // local ULID, NOT the cloud uuid
  });

  it("NEVER sends a payload / embedding over the wire (privacy invariant)", async () => {
    await store.add(
      newItem({ payload: { embedding: [0.1, 0.2, 0.3], extra: "x" } } as Partial<NewMemoryItem>),
      AUDIT,
    );
    const body = sync.mock.calls[0]![1] as { items: MemoryItemSyncInput[] };
    const sent = body.items[0]! as unknown as Record<string, unknown>;
    expect(sent).not.toHaveProperty("payload");
    expect(sent).not.toHaveProperty("embedding");
    expect(JSON.stringify(body)).not.toContain("embedding");
  });

  it("clamps confirmed-outcome to private before it leaves the device", async () => {
    await store.add(newItem({ kind: "confirmed-outcome", visibility: "team" }), AUDIT);
    const body = sync.mock.calls[0]![1] as { items: MemoryItemSyncInput[] };
    expect(body.items[0]!.visibility).toBe("private");
  });

  it("query() fails closed on a missing repo (HOR-46)", async () => {
    const rows = await store.query({ repo: "  " });
    expect(rows).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("query() lists items, maps them back, and applies client-side filters", async () => {
    list.mockResolvedValue({
      items: [
        record({ clientId: "a", status: "fresh", kind: "decision" }),
        record({ clientId: "b", status: "forgotten", kind: "decision" }),
      ],
    });
    const rows = await store.query({ repo: "horus", status: ["fresh"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("a");
    expect(rows[0]!.repo).toBe("horus");
  });

  it("get() returns null when the item is not in the list", async () => {
    list.mockResolvedValue({ items: [record({ clientId: "other" })] });
    expect(await store.get("missing")).toBeNull();
  });

  it("get() maps a 404 to null", async () => {
    list.mockRejectedValue(new CloudError(404, "not_found", "nope"));
    expect(await store.get("x")).toBeNull();
  });

  it("setStatus/setVisibility/verify route through syncMemoryItems as patches", async () => {
    await store.setStatus("01JADD", "pinned", AUDIT);
    await store.setVisibility("01JADD", "team", AUDIT);
    await store.verify("01JADD", { lastVerifiedHash: "deadbeef" }, AUDIT);
    expect(sync.mock.calls[0]![1]).toEqual({ items: [{ clientId: "01JADD", status: "pinned" }] });
    expect(sync.mock.calls[1]![1]).toEqual({ items: [{ clientId: "01JADD", visibility: "team" }] });
    expect((sync.mock.calls[2]![1] as { items: MemoryItemSyncInput[] }).items[0]).toMatchObject({
      clientId: "01JADD",
      lastVerifiedHash: "deadbeef",
    });
  });

  it("links/history are not cloud-backed in M3 (return empty)", async () => {
    expect(await store.links("01JADD")).toEqual([]);
    expect(await store.history("01JADD")).toEqual([]);
  });
});

describe("dualWriteMemoryStore", () => {
  function makeLocal(): MemoryStore {
    return {
      recall: vi.fn(async () => []),
      record: vi.fn(async () => {}),
      loadScoped: vi.fn(async () => []),
      add: vi.fn(async (item: NewMemoryItem) => ({ ...newItem(), id: item.id ?? "local-id" }) as never),
      get: vi.fn(async () => null),
      query: vi.fn(async () => []),
      setStatus: vi.fn(async () => {}),
      setVisibility: vi.fn(async () => {}),
      verify: vi.fn(async () => {}),
      addLink: vi.fn(async () => {}),
      links: vi.fn(async () => []),
      history: vi.fn(async () => []),
    };
  }

  it("writes local first, then mirrors to cloud best-effort", async () => {
    const local = makeLocal();
    const cloud = makeLocal();
    const store = dualWriteMemoryStore(local, cloud);
    await store.add(newItem(), AUDIT);
    expect(local.add).toHaveBeenCalledTimes(1);
    expect(cloud.add).toHaveBeenCalledTimes(1);
  });

  it("a cloud failure NEVER throws and is reported", async () => {
    const local = makeLocal();
    const cloud = makeLocal();
    (cloud.setStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    const onErr = vi.fn();
    const store = dualWriteMemoryStore(local, cloud, onErr);
    await expect(store.setStatus("01JADD", "pinned", AUDIT)).resolves.toBeUndefined();
    expect(local.setStatus).toHaveBeenCalledTimes(1);
    expect(onErr).toHaveBeenCalledTimes(1);
  });

  it("reads always come from local", async () => {
    const local = makeLocal();
    const cloud = makeLocal();
    const store = dualWriteMemoryStore(local, cloud);
    await store.query({ repo: "horus" });
    expect(local.query).toHaveBeenCalledTimes(1);
    expect(cloud.query).not.toHaveBeenCalled();
  });
});
