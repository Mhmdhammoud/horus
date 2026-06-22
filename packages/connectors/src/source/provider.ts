/**
 * SourceCodeProvider — the code-graph `CodeProvider` backed by a running `horus-source host`.
 *
 * All traversals go through the source-intelligence HTTP `/api/cypher` surface (or the
 * typed `/api/impact` and `/api/diff` endpoints). Cypher has NO parameter binding, so node
 * ids are escaped and inlined into each query string. Rows come back as positional
 * arrays aligned to the RETURN columns, so every indexed access is guarded.
 */

import type {
  Symbol,
  SymbolContext,
  ImpactResult,
  ChangeSet,
  CypherResult,
  CommunityRef,
  CoupledFile,
  Flow,
  HealthStatus,
} from '@horus/core';
import type { SourceHttpClient } from './client.js';
import type { SourceNode } from './types.js';
import type { CodeProvider } from '../contract.js';

export class SourceCodeProvider implements CodeProvider {
  readonly id = 'source';
  readonly kind = 'code' as const;

  constructor(private readonly client: SourceHttpClient) {}

  // --- helpers -------------------------------------------------------------

  /**
   * Escape a node id for inlining inside a double-quoted Cypher string literal:
   * first double every backslash, then escape every double-quote.
   */
  private escapeId(id: string): string {
    return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private nodeToSymbol(n: SourceNode): Symbol {
    return {
      id: n.id,
      name: n.name,
      filePath: n.filePath,
      startLine: n.startLine,
      endLine: n.endLine,
      signature: n.signature,
      language: n.language,
      className: n.className,
    };
  }

  private async rows(query: string): Promise<unknown[][]> {
    return (await this.client.cypher(query)).rows;
  }

  private cypherRowToSymbol(
    row: unknown[],
    idIdx: number,
    nameIdx: number,
    fileIdx: number,
    lineIdx?: number,
    classNameIdx?: number,
  ): Symbol {
    const startLine =
      lineIdx != null && row[lineIdx] != null ? Number(row[lineIdx]) : undefined;
    const sym: Symbol = {
      id: String(row[idIdx] ?? ''),
      name: String(row[nameIdx] ?? ''),
      filePath: String(row[fileIdx] ?? ''),
      startLine,
    };
    if (classNameIdx != null && row[classNameIdx] != null) {
      sym.className = String(row[classNameIdx]);
    }
    return sym;
  }

  // --- contract ------------------------------------------------------------

  async health(): Promise<HealthStatus> {
    const h = await this.client.health();
    return {
      ok: h.ok,
      detail: h.ok ? 'Source intelligence host responded ' + h.status : 'Source intelligence host unreachable',
    };
  }

  async searchSymbols(query: string, limit = 10): Promise<Symbol[]> {
    const E = this.escapeId(query);

    // Phase 1: deterministic exact-name lookup via Cypher.
    // Vector search can rank unrelated symbols above exact-name hits when embedding
    // similarity is misleading (HOR-164). An exact Cypher match is always authoritative.
    // NB: Kùzu rejects the label-negation predicate `NOT n:File` with a parser error
    // (HOR-208) — that silently made this whole exact-match phase throw and fall back to
    // fuzzy search, so e.g. `GaiaController` resolved to `SchedulerController`. Use the
    // portable `label(n) <> "File"` form instead.
    const exactQuery =
      `MATCH (n) WHERE toLower(n.name) = toLower("${E}") AND label(n) <> "File" ` +
      `RETURN n.id, n.name, n.file_path LIMIT ${limit}`;

    // Phase 2: semantic search — run in parallel with Phase 1.
    const [exactRows, semanticRes] = await Promise.all([
      this.rows(exactQuery).catch((): unknown[][] => []),
      this.client.search(query, limit),
    ]);

    const exactSymbols: Symbol[] = exactRows.map((row) => ({
      id: String(row[0] ?? ''),
      name: String(row[1] ?? ''),
      filePath: String(row[2] ?? ''),
    }));

    const exactIds = new Set(exactSymbols.map((s) => s.id));
    const ql = query.toLowerCase();

    // Re-rank semantic results: partial name matches above pure embedding-only matches,
    // File-label results below all symbol matches.
    const semantic = semanticRes
      .filter((r) => !exactIds.has(r.nodeId))
      .map((r) => {
        const nl = r.name.toLowerCase();
        const isFile = r.label === 'File';
        let rank = 0;
        if (!isFile && (nl.includes(ql) || ql.includes(nl))) rank = 2;
        else if (isFile && (nl.includes(ql) || ql.includes(nl))) rank = 1;
        return { r, rank };
      });

    semantic.sort((a, b) => b.rank - a.rank || b.r.score - a.r.score);

    const combined: Symbol[] = [
      ...exactSymbols,
      ...semantic.map(({ r }) => ({ id: r.nodeId, name: r.name, filePath: r.filePath })),
    ];

    // Hydrate start/end lines from the graph (HOR-211). The exact-match Cypher and the
    // semantic search both return only id/name/file, so without this seeds/evidence render
    // as `file:0`. One batched lookup by id fills in real line ranges for the page.
    return this.hydrateLines(combined.slice(0, limit));
  }

  /** Attach start/end line ranges to symbols via a single batched id lookup. */
  private async hydrateLines(symbols: Symbol[]): Promise<Symbol[]> {
    const ids = symbols.map((s) => s.id).filter(Boolean);
    if (ids.length === 0) return symbols;
    const idList = ids.map((id) => `"${this.escapeId(id)}"`).join(', ');
    const rows = await this
      .rows(`MATCH (n) WHERE n.id IN [${idList}] RETURN n.id, n.start_line, n.end_line`)
      .catch((): unknown[][] => []);
    const lineById = new Map<string, { start?: number; end?: number }>();
    for (const row of rows) {
      const id = String(row[0] ?? '');
      const start = row[1] != null ? Number(row[1]) : undefined;
      const end = row[2] != null ? Number(row[2]) : undefined;
      lineById.set(id, { start, end });
    }
    return symbols.map((s) => {
      const l = lineById.get(s.id);
      if (l === undefined) return s;
      const out = { ...s };
      if (l.start !== undefined && Number.isFinite(l.start)) out.startLine = l.start;
      if (l.end !== undefined && Number.isFinite(l.end)) out.endLine = l.end;
      return out;
    });
  }

  async context(symbolId: string): Promise<SymbolContext> {
    const E = this.escapeId(symbolId);

    const nodeQuery =
      `MATCH (n) WHERE n.id = "${E}" ` +
      `RETURN n.id, n.name, n.file_path, n.start_line, n.end_line, ` +
      `n.signature, n.class_name, n.language, n.is_dead, n.content LIMIT 1`;
    const calleesQuery =
      `MATCH (n)-[r:CodeRelation]->(m) WHERE n.id = "${E}" AND r.rel_type = "calls" ` +
      `RETURN m.id, m.name, m.file_path, m.start_line, m.class_name`;
    const callersQuery =
      `MATCH (m)-[r:CodeRelation]->(n) WHERE n.id = "${E}" AND r.rel_type = "calls" ` +
      `RETURN m.id, m.name, m.file_path, m.start_line, m.class_name`;
    const usesTypeQuery =
      `MATCH (n)-[r:CodeRelation]->(t) WHERE n.id = "${E}" AND r.rel_type = "uses_type" ` +
      `RETURN t.id, t.name, t.file_path, t.start_line`;
    const communityQuery =
      `MATCH (n)-[r:CodeRelation]->(c:Community) WHERE n.id = "${E}" ` +
      `AND r.rel_type = "member_of" RETURN c.id, c.name LIMIT 1`;
    const fileQuery =
      `MATCH (f:File)-[r:CodeRelation]->(n) WHERE n.id = "${E}" ` +
      `AND r.rel_type = "defines" RETURN f.id, f.file_path LIMIT 1`;

    const [nodeRows, calleeRows, callerRows, usesTypeRows, communityRows, fileRows] =
      await Promise.all([
        this.rows(nodeQuery),
        this.rows(calleesQuery),
        this.rows(callersQuery),
        this.rows(usesTypeQuery),
        this.rows(communityQuery),
        this.rows(fileQuery),
      ]);

    const node = nodeRows[0];
    const symbol: Symbol = {
      id: String(node?.[0] ?? symbolId),
      name: String(node?.[1] ?? ''),
      filePath: String(node?.[2] ?? ''),
      startLine: node?.[3] != null ? Number(node[3]) : undefined,
      endLine: node?.[4] != null ? Number(node[4]) : undefined,
      signature: node?.[5] != null ? String(node[5]) : undefined,
      className: node?.[6] != null ? String(node[6]) : undefined,
      language: node?.[7] != null ? String(node[7]) : undefined,
    };
    const isDead = Boolean(node?.[8]);
    const content = node?.[9];
    const snippet =
      typeof content === 'string' ? content.slice(0, 600) : undefined;

    const callees = calleeRows.map((row) => this.cypherRowToSymbol(row, 0, 1, 2, 3, 4));
    const callers = callerRows.map((row) => this.cypherRowToSymbol(row, 0, 1, 2, 3, 4));
    const usesType = usesTypeRows.map((row) => this.cypherRowToSymbol(row, 0, 1, 2, 3));

    const communityRow = communityRows[0];
    const community: CommunityRef | null = communityRow
      ? { id: String(communityRow[0] ?? ''), name: String(communityRow[1] ?? '') }
      : null;

    let imports: string[] = [];
    let coupledWith: CoupledFile[] = [];
    const fileRow = fileRows[0];
    const fileId = fileRow?.[0];
    if (fileId != null) {
      const FE = this.escapeId(String(fileId));
      const importsQuery =
        `MATCH (f)-[r:CodeRelation]->(g:File) WHERE f.id = "${FE}" ` +
        `AND r.rel_type = "imports" RETURN g.file_path`;
      const coupledQuery =
        `MATCH (f)-[r:CodeRelation]->(g:File) WHERE f.id = "${FE}" ` +
        `AND r.rel_type = "coupled_with" RETURN g.file_path, r.co_changes`;

      const [importRows, coupledRows] = await Promise.all([
        this.rows(importsQuery),
        this.rows(coupledQuery),
      ]);

      imports = importRows.map((row) => String(row[0] ?? ''));
      coupledWith = coupledRows.map((row) => ({
        file: String(row[0] ?? ''),
        coChanges: Number(row[1] ?? 0),
      }));
    }

    return {
      symbol,
      snippet,
      callers,
      callees,
      imports,
      usesType,
      community,
      coupledWith,
      isDead,
    };
  }

  async impact(symbolId: string, depth = 3): Promise<ImpactResult> {
    const r = await this.client.impact(symbolId, depth);
    return {
      target: this.nodeToSymbol(r.target),
      affected: r.affected,
      byDepth: Object.entries(r.depths)
        .map(([d, nodes]) => ({
          depth: Number(d),
          symbols: nodes.map((n) => this.nodeToSymbol(n)),
        }))
        .sort((a, b) => a.depth - b.depth),
    };
  }

  async flowsFor(symbolId: string): Promise<Flow[]> {
    const E = this.escapeId(symbolId);
    const procQuery =
      `MATCH (s)-[r:CodeRelation]->(p:Process) WHERE s.id = "${E}" ` +
      `AND r.rel_type = "step_in_process" RETURN p.id, p.name`;
    const procRows = await this.rows(procQuery);

    const flows = await Promise.all(
      procRows.map(async (proc): Promise<Flow> => {
        const pid = proc[0];
        const pname = proc[1];
        const PE = this.escapeId(String(pid ?? ''));
        const stepQuery =
          `MATCH (s)-[r:CodeRelation]->(p:Process) WHERE p.id = "${PE}" ` +
          `AND r.rel_type = "step_in_process" ` +
          `RETURN s.id, s.name, s.file_path, s.start_line, r.step_number ` +
          `ORDER BY r.step_number`;
        const stepRows = await this.rows(stepQuery);
        const steps = stepRows.map((row) => this.cypherRowToSymbol(row, 0, 1, 2, 3));
        return { id: String(pid ?? ''), name: String(pname ?? ''), steps };
      }),
    );

    return flows;
  }

  async detectChanges(diff: { base: string; compare: string }): Promise<ChangeSet> {
    const d = await this.client.diff(diff.base, diff.compare);
    return {
      added: d.added.map((n) => this.nodeToSymbol(n)),
      removed: d.removed.map((n) => this.nodeToSymbol(n)),
      modified: d.modified.map((m) => ({
        before: this.nodeToSymbol(m.before),
        after: this.nodeToSymbol(m.after),
      })),
    };
  }

  cypher(query: string): Promise<CypherResult> {
    return this.client.cypher(query);
  }
}
