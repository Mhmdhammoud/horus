/**
 * Thin client for the Horus Cloud `/v1` API (HOR-236). The CLI talks to the
 * cloud ONLY through this contract — it never holds DB credentials (HOR-221).
 */

export const DEFAULT_API_BASE_URL = "https://api.horus.dev";

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

  context(): Promise<ContextResponse> {
    return this.request<ContextResponse>("GET", "/v1/context");
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
}
