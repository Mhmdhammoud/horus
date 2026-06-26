/**
 * Reusable cloud write-path library (HOR-239): persist and retrieve a Horus
 * investigation through the Horus Cloud API. The CLI never touches cloud
 * Postgres directly. (The `horus investigate`/`ask` command wiring that calls
 * these helpers is HOR-228.)
 */
import type { CloudClient, EvidenceRecord, InvestigationRecord } from "./api.js";
import type { CloudConfig } from "./context-store.js";
import type { InvestigationReport } from "@horus/engine";
import { HORUS_VERSION } from "@horus/core";

// The cloud evidence schema (HOR-227/HOR-233) requires a valid `type` enum plus
// title/content/contentFormat. A Horus report snapshot is stored as a `note`
// with the full report serialized into `content` (and mirrored in `payload` for
// convenient structured retrieval). `payload.kind` marks it as our snapshot.
const REPORT_EVIDENCE_TYPE = "note";
const REPORT_EVIDENCE_SOURCE = "cli";
const REPORT_EVIDENCE_TITLE = "Investigation report snapshot";
const REPORT_EVIDENCE_KIND = "horus:report";
const REPORT_CONTENT_FORMAT = "application/json";

export interface CloudInvestigationRefs {
  projectId: string;
  investigationId: string;
}

function idempotencyKey(reportId: string, suffix: string): string {
  return `${reportId}:${suffix}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Upload the results of a locally-run investigation to Horus Cloud.
 *
 * Creates the investigation, attaches a snapshot of the full report as
 * evidence, and records the CLI execution as an AgentRun. This keeps the
 * deterministic engine local while sharing results through the cloud API.
 */
export async function uploadInvestigationToCloud(
  client: CloudClient,
  cfg: CloudConfig,
  report: InvestigationReport,
): Promise<CloudInvestigationRefs> {
  if (!cfg.project) {
    throw new Error("Cloud config is missing a linked project.");
  }

  const projectId = cfg.project.id;
  const repositoryIds = cfg.repository?.id ? [cfg.repository.id] : undefined;

  const investigation = await client.createInvestigation(projectId, {
    title: report.input.hint.slice(0, 500) || "Untitled investigation",
    hint: report.input.hint,
    repositoryIds,
    idempotencyKey: idempotencyKey(report.id, "investigation"),
  });

  await client.createEvidence(projectId, investigation.id, {
    type: REPORT_EVIDENCE_TYPE,
    source: REPORT_EVIDENCE_SOURCE,
    title: REPORT_EVIDENCE_TITLE,
    content: JSON.stringify(report),
    contentFormat: REPORT_CONTENT_FORMAT,
    payload: { kind: REPORT_EVIDENCE_KIND, report: clone(report) },
    idempotencyKey: idempotencyKey(report.id, "report"),
  });

  await client.createAgentRun(projectId, investigation.id, {
    repositoryId: cfg.repository?.id,
    status: "completed",
    agent: "Horus CLI",
    cliVersion: HORUS_VERSION,
    summary: report.summary,
    idempotencyKey: idempotencyKey(report.id, "run"),
  });

  await client.updateInvestigation(projectId, investigation.id, { status: "completed" });

  return { projectId, investigationId: investigation.id };
}

function findReportEvidence(evidence: EvidenceRecord[]): InvestigationReport | null {
  const record = evidence.find((e) => {
    const payload = e.payload as { kind?: unknown } | undefined;
    return e.source === REPORT_EVIDENCE_SOURCE && payload?.kind === REPORT_EVIDENCE_KIND;
  });
  if (!record) return null;
  // Prefer the structured payload mirror; fall back to the serialized content.
  const payload = record.payload as { report?: unknown } | undefined;
  if (payload?.report) return clone(payload.report) as InvestigationReport;
  try {
    return JSON.parse(record.content) as InvestigationReport;
  } catch {
    return null;
  }
}

/**
 * Fetch a cloud investigation and reconstruct the saved report from its
 * evidence. Returns null when no report snapshot is attached.
 */
export async function fetchInvestigationReportFromCloud(
  client: CloudClient,
  cfg: CloudConfig,
  investigationId: string,
): Promise<InvestigationReport | null> {
  if (!cfg.project) {
    throw new Error("Cloud config is missing a linked project.");
  }

  const projectId = cfg.project.id;
  await client.getInvestigation(projectId, investigationId);
  const evidence = await client.listEvidence(projectId, investigationId);
  return findReportEvidence(evidence);
}

export async function listCloudInvestigations(
  client: CloudClient,
  cfg: CloudConfig,
): Promise<InvestigationRecord[]> {
  if (!cfg.project) {
    throw new Error("Cloud config is missing a linked project.");
  }
  const result = await client.listInvestigations(cfg.project.id);
  return result.investigations;
}
