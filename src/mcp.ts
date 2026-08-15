import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionStore } from "./store.js";
import { getSessionExcerpt } from "./excerpt.js";

const asText = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

export function buildMcpServer(store: SessionStore): McpServer {
  const server = new McpServer({ name: "sessiontrack", version: "0.1.0" });

  server.registerTool("search_sessions", {
    description:
      "Search LLM digests of every Claude Code session on this machine. " +
      "Returns compact ranked snippets (~200 tokens each). Use this FIRST to find prior work.",
    inputSchema: {
      query: z.string().describe("keywords, e.g. 'jwt auth refresh'"),
      project: z.string().optional().describe(
        "project filter: case-insensitive substring of the stored project path " +
        "(a folder name like 'pethbhar-webapp' works). Projects that moved on disk " +
        "are stored under their OLD path — prefer omitting this filter and adding " +
        "a project word to the query, or check list_projects for stored paths."),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, async ({ query, project, limit }) =>
    asText(store.searchSessions(query, { project, limit: limit ?? 10 })));

  server.registerTool("get_session_digest", {
    description: "Full digest of one session: summary, decisions, outcome, topics, files edited.",
    inputSchema: { session_id: z.string() },
  }, async ({ session_id }) => {
    const row = store.getSession(session_id);
    return asText(row ?? { error: "not found" });
  });

  server.registerTool("get_session_excerpt", {
    description:
      "Drill into ONE session's raw transcript for details the digest lacks. " +
      "Returns up to 5 matching message snippets. Costlier than digests — use sparingly.",
    inputSchema: { session_id: z.string(), query: z.string() },
  }, async ({ session_id, query }) => {
    const row = store.getSession(session_id);
    if (!row) return asText({ error: "not found" });
    try { return asText(getSessionExcerpt(row.filePath, query)); }
    catch { return asText({ error: "source transcript missing" }); }
  });

  server.registerTool("related_sessions", {
    description: "Sessions related to a given one via shared edited files, shared topics, or continuation.",
    inputSchema: { session_id: z.string() },
  }, async ({ session_id }) => asText(store.relatedSessions(session_id)));

  server.registerTool("list_projects", {
    description: "All projects with indexed sessions: path, session count, last activity.",
    inputSchema: {},
  }, async () => asText(store.listProjects()));

  return server;
}
