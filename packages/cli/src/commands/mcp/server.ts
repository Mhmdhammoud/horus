/**
 * Horus MCP server (HOR-295) — stdio transport exposing the local
 * project-knowledge index to coding agents (Claude Code, Codex, Cursor, …).
 *
 * One generic Horus MCP, not a custom server per project: it reads the active
 * repo's `.horus/index/` snapshot through the same query layer as `horus
 * knowledge`. Offline / local-only — never contacts Horus Cloud.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { findRepoRoot } from '@horus/core';
import { KNOWLEDGE_TOOLS } from './tools.js';

const SERVER_INSTRUCTIONS =
  'Horus exposes a local, indexed understanding of THIS project. Before grepping or reading ' +
  'the whole repo to answer project-level questions (what owns a feature, which operation/type/' +
  'enum/auth rule applies, which frontend pattern exists, which worker/queue handles a job), ' +
  'call these Horus knowledge tools first. Every result includes provenance and a staleness flag; ' +
  'if the index is stale, suggest re-running `horus index`.';

/** Build (but do not connect) the Horus MCP server for a repo root. Testable. */
export function buildMcpServer(root: string): McpServer {
  const server = new McpServer(
    { name: 'horus', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of KNOWLEDGE_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args: Record<string, unknown>) => {
        const res = tool.handler(args ?? {}, root);
        return {
          content: [
            {
              type: 'text' as const,
              text: `${res.summary}\n\n${JSON.stringify(res.data ?? null, null, 2)}`,
            },
          ],
          isError: !res.ok,
        };
      },
    );
  }
  return server;
}

/** Run the Horus MCP server over stdio. Resolves once connected; stdio keeps it alive. */
export async function runMcpServer(opts: { root?: string } = {}): Promise<number> {
  const root = opts.root ?? findRepoRoot(process.cwd()) ?? process.cwd();
  const server = buildMcpServer(root);
  await server.connect(new StdioServerTransport());
  return 0;
}
