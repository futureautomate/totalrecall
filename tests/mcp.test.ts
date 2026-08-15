import { describe, it, expect } from "vitest";
import { buildMcpServer } from "../src/mcp.js";
import { SessionStore } from "../src/store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("mcp server", () => {
  it("lists tools and answers search_sessions", async () => {
    const store = new SessionStore(":memory:");
    store.upsertSession({
      sessionId: "s1", projectPath: "D:\\p", filePath: "C:\\fake.jsonl",
      startedAt: null, endedAt: null, firstPrompt: null, aiTitle: null,
      gitBranch: null, models: [], messageCount: 1, filesEdited: [],
      fileMtimeMs: 1, fileSize: 1,
    });
    store.setDigest("s1", {
      title: "Redis cache", summary: "Added a redis cache layer.",
      decisions: [], outcome: "completed", topics: ["redis"],
    });

    const server = buildMcpServer(store);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientT);

    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual([
      "get_session_digest", "get_session_excerpt", "list_projects",
      "related_sessions", "search_sessions",
    ]);

    const res: any = await client.callTool({
      name: "search_sessions", arguments: { query: "redis cache" },
    });
    expect(res.content[0].text).toContain("s1");
  });
});
