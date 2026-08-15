import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../src/store.js";
import type { SessionMeta, Digest } from "../src/types.js";

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id, projectPath: "D:\\Projects\\demo", filePath: `C:\\fake\\${id}.jsonl`,
    startedAt: "2026-08-01T10:00:00.000Z", endedAt: "2026-08-01T11:00:00.000Z",
    firstPrompt: `prompt ${id}`, aiTitle: `title ${id}`, gitBranch: null, models: [],
    messageCount: 5, filesEdited: [], fileMtimeMs: 1, fileSize: 1, ...over,
  };
}
function digest(over: Partial<Digest> = {}): Digest {
  return { title: "t", summary: "s", decisions: [], outcome: "completed", topics: [], ...over };
}

describe("UI store methods", () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore(":memory:");
    store.upsertSession(meta("a", { startedAt: "2026-08-01T10:00:00.000Z" }));
    store.setDigest("a", digest({ title: "Auth work", topics: ["auth", "jwt"] }));
    store.upsertSession(meta("b", { startedAt: "2026-08-05T10:00:00.000Z",
      projectPath: "D:\\Projects\\other", filesEdited: ["D:\\x\\a.ts"] }));
    store.setDigest("b", digest({ title: "Deploy", outcome: "ongoing", topics: ["deploy", "auth"] }));
    store.upsertSession(meta("c", { startedAt: "2026-08-10T10:00:00.000Z" })); // undigested
  });

  describe("listSessions", () => {
    it("lists newest-first with total", () => {
      const r = store.listSessions({});
      expect(r.total).toBe(3);
      expect(r.rows.map(x => x.sessionId)).toEqual(["c", "b", "a"]);
    });
    it("filters by project fragment (case-insensitive)", () => {
      expect(store.listSessions({ project: "OTHER" }).rows.map(x => x.sessionId)).toEqual(["b"]);
    });
    it("filters by outcome and date range", () => {
      expect(store.listSessions({ outcome: "ongoing" }).rows.map(x => x.sessionId)).toEqual(["b"]);
      expect(store.listSessions({ from: "2026-08-04", to: "2026-08-06" }).rows.map(x => x.sessionId)).toEqual(["b"]);
    });
    it("pages with limit/offset while total stays full", () => {
      const r = store.listSessions({ limit: 1, offset: 1 });
      expect(r.rows.map(x => x.sessionId)).toEqual(["b"]);
      expect(r.total).toBe(3);
    });
  });

  describe("projectStats", () => {
    it("reports counts, coverage and top topics per project", () => {
      const stats = store.projectStats();
      const demo = stats.find(p => p.projectPath.endsWith("demo"))!;
      expect(demo.sessionCount).toBe(2);
      expect(demo.digested).toBe(1);
      expect(demo.pending).toBe(1);
      expect(demo.topTopics).toEqual(["auth", "jwt"]);
      const other = stats.find(p => p.projectPath.endsWith("other"))!;
      expect(other.digested).toBe(1);
      expect(other.topTopics).toContain("deploy");
    });
  });

  describe("graphData", () => {
    it("builds session, topic and project nodes with about/in_project edges", () => {
      const g = store.graphData({});
      const ids = g.nodes.map(n => n.id);
      expect(ids).toContain("a");
      expect(ids).toContain("topic:auth");
      expect(ids).toContain("project:D:\\Projects\\demo");
      expect(g.nodes.filter(n => n.type === "topic").length).toBe(3); // auth, jwt, deploy
      expect(g.edges).toContainEqual({ source: "a", target: "topic:auth", kind: "about" });
      expect(g.edges).toContainEqual({ source: "a", target: "project:D:\\Projects\\demo", kind: "in_project" });
      // undigested session c is still a node (no topic edges), so the graph shows all sessions
      expect(ids).toContain("c");
    });
    it("respects filters and drops orphaned topic nodes", () => {
      const g = store.graphData({ project: "other" });
      const ids = g.nodes.map(n => n.id);
      expect(ids).toEqual(expect.arrayContaining(["b", "topic:deploy", "topic:auth"]));
      expect(ids).not.toContain("topic:jwt");
      expect(ids).not.toContain("a");
    });
    it("session nodes carry label, project, outcome, messageCount, startedAt", () => {
      const g = store.graphData({});
      const a = g.nodes.find(n => n.id === "a")!;
      expect(a).toMatchObject({ type: "session", label: "Auth work", project: "D:\\Projects\\demo",
        outcome: "completed", messageCount: 5, startedAt: "2026-08-01T10:00:00.000Z" });
      const c = g.nodes.find(n => n.id === "c")!;
      expect(c.label).toBe("title c"); // falls back to aiTitle when undigested
    });
  });
});
