/**
 * Thin client for the Horus Cloud `/v1` API (HOR-236). The CLI talks to the
 * cloud ONLY through this contract — it never holds DB credentials (HOR-221).
 */

export const DEFAULT_API_BASE_URL = "https://api.horus.sh";

export class CloudError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

/** Network/connection failure (offline, DNS, refused) — distinct from HTTP errors. */
export class CloudOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudOfflineError";
  }
}

export interface MeResponse {
  user: { id: string; primaryEmail: string; displayName?: string | null };
  memberships: { organizationId: string; role: "owner" | "admin" | "member"; workspaceIds: string[] }[];
}

/** Response from POST /v1/cli-sessions/start (device-login init). */
export interface CliSessionStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** Response from POST /v1/cli-sessions/poll. `token` is present only once, on approval. */
export interface CliSessionPoll {
  status: "pending" | "slow_down" | "approved" | "denied" | "expired";
  interval?: number;
  token?: string;
  account?: { userId: string; email: string };
}

export interface ContextResponse {
  user: { id: string; primaryEmail: string; displayName?: string | null };
  organizations: { id: string; slug: string; name: string; role: "owner" | "admin" | "member" }[];
  workspaces: { id: string; slug: string; name: string; organizationId: string }[];
  // A project IS the repository/codebase (HOR-280). The cloud `/v1/context`
  // returns repo/sync metadata on each project (HOR-277); the fields are optional
  // so the CLI degrades gracefully against an older cloud build.
  projects: {
    id: string;
    slug: string;
    name: string;
    workspaceId: string;
    organizationId: string;
    provider?: string | null;
    remoteUrl?: string | null;
    defaultBranch?: string | null;
    lastSeenCommit?: string | null;
    lastSyncedAt?: string | null;
  }[];
}

export interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface InvestigationRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  organizationId: string;
  title: string;
  hint: string | null;
  status: string;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvestigationDetail extends InvestigationRecord {
  repositoryIds: string[];
}

export interface EvidenceRecord {
  id: string;
  investigationId: string;
  projectId: string;
  organizationId: string;
  type: string;
  source: string;
  title: string;
  content: string;
  contentFormat: string;
  payload: unknown;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface AgentRunRecord {
  id: string;
  investigationId: string;
  projectId: string;
  organizationId: string;
  repositoryId: string | null;
  status: string;
  cliVersion: string | null;
  summary: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

/**
 * A knowledge snapshot record stored in Horus Cloud (HOR-296). The cloud stores
 * the structured snapshot + manifest keyed by content hash for dedup + freshness;
 * it never owns indexing (the CLI is the source of truth).
 */
export interface KnowledgeSnapshotRecord {
  id: string;
  projectId: string;
  schemaVersion: number;
  contentHash: string;
  gitSha: string | null;
  branch: string | null;
  generatedAt: string;
  counts: Record<string, number>;
  /** The serialized KnowledgeSnapshot (present on detail/latest reads). */
  snapshot?: unknown;
  /** The serialized KnowledgeManifest. */
  manifest?: unknown;
  archived: boolean;
  createdAt: string;
}

export interface PushKnowledgeSnapshotBody {
  schemaVersion: number;
  contentHash: string;
  gitSha?: string;
  branch?: string;
  generatedAt: string;
  counts?: Record<string, number>;
  snapshot: unknown;
  manifest: unknown;
  /** Defaults to the content hash — server dedups idempotent re-pushes. */
  idempotencyKey?: string;
}

export interface ChangeReportBody {
  service?: string;
  since?: string;
  until?: string;
  summary: string;
  commitCount?: number;
  contributorCount?: number;
  symbolsAdded?: number;
  symbolsModified?: number;
  symbolsRemoved?: number;
  queueTopologyTouched?: boolean;
  /** The full deterministic WhatChangedReport, stored for the dashboard. */
  payload?: Record<string, unknown>;
}

export interface ChangeReportRecord {
  id: string;
  projectId: string;
  summary: string;
  createdAt: string;
}

export class CloudClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new CloudOfflineError(
        `Cannot reach Horus Cloud at ${this.baseUrl} (${(err as Error).message}).`,
      );
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;

    if (!res.ok) {
      const envelope = json as { error?: { code?: string; message?: string } } | undefined;
      throw new CloudError(
        res.status,
        envelope?.error?.code ?? "http_error",
        envelope?.error?.message ?? `Request failed (${res.status}).`,
      );
    }
    return json as T;
  }

  me(): Promise<MeResponse> {
    return this.request<MeResponse>("GET", "/v1/me");
  }

  /** Begin a browser device-login session (no auth required). */
  startCliSession(): Promise<CliSessionStart> {
    return this.request<CliSessionStart>("POST", "/v1/cli-sessions/start");
  }

  /** Poll a device-login session until it is approved, denied, or expires. */
  pollCliSession(deviceCode: string): Promise<CliSessionPoll> {
    return this.request<CliSessionPoll>("POST", "/v1/cli-sessions/poll", { deviceCode });
  }

  context(): Promise<ContextResponse> {
    return this.request<ContextResponse>("GET", "/v1/context");
  }

  /** Create a workspace in an org (HOR-307 — used by `cloud link` create-from-repo). */
  createWorkspace(
    organizationId: string,
    body: { name: string; slug?: string },
  ): Promise<{ id: string; slug: string; name: string; organizationId: string }> {
    return this.request("POST", `/v1/organizations/${organizationId}/workspaces`, body);
  }

  /** Create a project in a workspace, optionally with its repo identity (HOR-307). */
  createProject(
    organizationId: string,
    workspaceId: string,
    body: { name: string; slug?: string; remoteUrl?: string; provider?: string },
  ): Promise<{ id: string; slug: string; name: string; workspaceId: string; organizationId: string }> {
    return this.request(
      "POST",
      `/v1/organizations/${organizationId}/workspaces/${workspaceId}/projects`,
      body,
    );
  }

  listTokens(): Promise<{ tokens: TokenSummary[] }> {
    return this.request<{ tokens: TokenSummary[] }>("GET", "/v1/cli/tokens");
  }

  revokeToken(id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/cli/tokens/${id}`);
  }

  createInvestigation(
    projectId: string,
    body: {
      title: string;
      hint?: string;
      repositoryIds?: string[];
      idempotencyKey?: string;
    },
  ): Promise<InvestigationRecord> {
    return this.request<InvestigationRecord>("POST", `/v1/projects/${projectId}/investigations`, body);
  }

  listInvestigations(
    projectId: string,
  ): Promise<{ investigations: InvestigationRecord[]; nextCursor?: string }> {
    return this.request<{ investigations: InvestigationRecord[]; nextCursor?: string }>(
      "GET",
      `/v1/projects/${projectId}/investigations`,
    );
  }

  getInvestigation(projectId: string, investigationId: string): Promise<InvestigationDetail> {
    return this.request<InvestigationDetail>(
      "GET",
      `/v1/projects/${projectId}/investigations/${investigationId}`,
    );
  }

  updateInvestigation(
    projectId: string,
    investigationId: string,
    body: { title?: string; hint?: string; status?: string },
  ): Promise<InvestigationRecord> {
    return this.request<InvestigationRecord>(
      "PATCH",
      `/v1/projects/${projectId}/investigations/${investigationId}`,
      body,
    );
  }

  addInvestigationRepositories(
    projectId: string,
    investigationId: string,
    repositoryIds: string[],
  ): Promise<InvestigationDetail> {
    return this.request<InvestigationDetail>(
      "POST",
      `/v1/projects/${projectId}/investigations/${investigationId}/repositories`,
      { repositoryIds },
    );
  }

  createEvidence(
    projectId: string,
    investigationId: string,
    body: {
      type: string;
      source: string;
      title: string;
      content: string;
      contentFormat: string;
      payload?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<EvidenceRecord> {
    return this.request<EvidenceRecord>(
      "POST",
      `/v1/projects/${projectId}/investigations/${investigationId}/evidence`,
      body,
    );
  }

  listEvidence(projectId: string, investigationId: string): Promise<EvidenceRecord[]> {
    return this.request<EvidenceRecord[]>(
      "GET",
      `/v1/projects/${projectId}/investigations/${investigationId}/evidence`,
    );
  }

  createAgentRun(
    projectId: string,
    investigationId: string,
    body: {
      repositoryId?: string;
      status?: string;
      agent?: string;
      model?: string;
      cliVersion?: string;
      summary?: string;
      idempotencyKey?: string;
    },
  ): Promise<AgentRunRecord> {
    return this.request<AgentRunRecord>(
      "POST",
      `/v1/projects/${projectId}/investigations/${investigationId}/agent-runs`,
      body,
    );
  }

  // ── Knowledge snapshots (HOR-296) ──────────────────────────────────────────

  /** Upload a local knowledge snapshot. Content-hash idempotent (server dedups). */
  pushKnowledgeSnapshot(
    projectId: string,
    body: PushKnowledgeSnapshotBody,
  ): Promise<KnowledgeSnapshotRecord> {
    return this.request<KnowledgeSnapshotRecord>(
      "POST",
      `/v1/projects/${projectId}/knowledge-snapshots`,
      body,
    );
  }

  /** Fetch the latest (non-archived) knowledge snapshot for a project. */
  getLatestKnowledgeSnapshot(projectId: string): Promise<KnowledgeSnapshotRecord> {
    return this.request<KnowledgeSnapshotRecord>(
      "GET",
      `/v1/projects/${projectId}/knowledge-snapshots/latest`,
    );
  }

  /** Push a `horus what-changed` report to the linked cloud project. */
  createChangeReport(
    projectId: string,
    body: ChangeReportBody,
  ): Promise<ChangeReportRecord> {
    return this.request<ChangeReportRecord>(
      "POST",
      `/v1/projects/${projectId}/changes`,
      body,
    );
  }
}
