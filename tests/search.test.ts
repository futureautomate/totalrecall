import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore, sanitizeFtsQuery } from "../src/store.js";
import type { SessionMeta, Digest } from "../src/types.js";

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id, projectPath: "D:\\Projects\\demo", filePath: `C:\\fake\\${id}.jsonl`,
    startedAt: "2026-08-01T10:00:00.000Z", endedAt: null, firstPrompt: null,
    aiTitle: null, gitBranch: null, models: [], messageCount: 1,
    filesEdited: [], fileMtimeMs: 1, fileSize: 1, ...over,
  };
}
function digest(over: Partial<Digest> = {}): Digest {
  return { title: "t", summary: "s", decisions: [], outcome: "completed", topics: [], ...over };
}

describe("search & graph", () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore(":memory:");
    store.upsertSession(meta("auth1", { filesEdited: ["D:\\demo\\auth.ts"] }));
    store.setDigest("auth1", digest({
      title: "JWT auth added", summary: "Implemented JWT authentication with refresh tokens.",
      topics: ["auth", "jwt"],
    }));
    store.upsertSession(meta("deploy1", {
      projectPath: "D:\\Projects\\other", filesEdited: ["D:\\demo\\auth.ts"],
    }));
    store.setDigest("deploy1", digest({
      title: "Caddy deploy", summary: "Set up Caddy reverse proxy deployment.",
      topics: ["deploy", "caddy"],
    }));
  });

  it("finds sessions by keyword ranked", () => {
    const hits = store.searchSessions("jwt authentication");
    expect(hits.length).toBe(1);
    expect(hits[0].sessionId).toBe("auth1");
    expect(hits[0].snippet.length).toBeGreaterThan(0);
  });

  it("filters by project", () => {
    const hits = store.searchSessions("deploy", { project: "D:\\Projects\\demo" });
    expect(hits.length).toBe(0);
  });

  it("does not throw on hostile query syntax", () => {
    expect(() => store.searchSessions('"unbalanced AND (weird')).not.toThrow();
  });

  it("lists projects with counts", () => {
    const projects = store.listProjects();
    expect(projects.length).toBe(2);
    expect(projects.find(p => p.projectPath.endsWith("demo"))!.sessionCount).toBe(1);
  });

  it("relates sessions sharing an edited file", () => {
    const related = store.relatedSessions("auth1");
    expect(related.map(r => r.sessionId)).toContain("deploy1");
  });

  it("sanitizeFtsQuery quotes every token", () => {
    expect(sanitizeFtsQuery('jwt auth')).toBe('"jwt" OR "auth"');
  });

  // The project filter must survive real-world sloppiness: Windows paths are
  // case-insensitive, and callers (usually an LLM guessing from its cwd) pass
  // fragments or differently-cased paths, not the exact stored string.
  it("project filter is case-insensitive", () => {
    const hits = store.searchSessions("caddy", { project: "d:\\projects\\OTHER" });
    expect(hits.map(h => h.sessionId)).toEqual(["deploy1"]);
  });

  it("project filter matches a path fragment", () => {
    const hits = store.searchSessions("caddy", { project: "other" });
    expect(hits.map(h => h.sessionId)).toEqual(["deploy1"]);
  });

  it("project filter with unmatched fragment still returns nothing", () => {
    const hits = store.searchSessions("caddy", { project: "vanidesk" });
    expect(hits.length).toBe(0);
  });

  // Important #4: relatedSessions must not be unbounded. A session sharing
  // one topic with a large fan-out of others should come back capped, not
  // with every single sharer.
  it("caps relatedSessions when many sessions share one topic", () => {
    store.upsertSession(meta("hub", { projectPath: "D:\\Projects\\fanout" }));
    store.setDigest("hub", digest({ topics: ["widget"] }));
    for (let i = 0; i < 30; i++) {
      const id = `fan${i}`;
      store.upsertSession(meta(id, { projectPath: "D:\\Projects\\fanout" }));
      store.setDigest(id, digest({ topics: ["widget"] }));
    }
    const related = store.relatedSessions("hub");
    expect(related.length).toBeLessThanOrEqual(25);
  });
});
