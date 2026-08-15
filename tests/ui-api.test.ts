import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createUiServer } from "../src/ui/server.js";
import { SessionStore } from "../src/store.js";
import type { SessionMeta, Digest } from "../src/types.js";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id, projectPath: "D:\\Projects\\demo", filePath: `C:\\fake\\${id}.jsonl`,
    startedAt: "2026-08-01T10:00:00.000Z", endedAt: null, firstPrompt: `prompt ${id}`,
    aiTitle: `title ${id}`, gitBranch: null, models: [], messageCount: 3,
    filesEdited: [], fileMtimeMs: 1, fileSize: 1, ...over,
  };
}
const digest = (over: Partial<Digest> = {}): Digest =>
  ({ title: "t", summary: "s", decisions: [], outcome: "completed", topics: [], ...over });

let base = "";
let server: ReturnType<typeof createUiServer>;

beforeAll(async () => {
  const store = new SessionStore(":memory:");
  // real transcript for the excerpt endpoint: copy the basic fixture to a temp file
  const fx = path.join(__dirname, "fixtures", "basic-session.jsonl");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tr-ui-")), "aaa-111.jsonl");
  fs.copyFileSync(fx, tmp);
  store.upsertSession(meta("aaa-111", { filePath: tmp, projectPath: "D:\\Projects\\demo" }));
  store.setDigest("aaa-111", digest({ title: "Login fix", summary: "Fixed unescaped SQL in login.", topics: ["login", "sql"] }));
  store.upsertSession(meta("s2", { projectPath: "D:\\Projects\\other", startedAt: "2026-08-05T10:00:00.000Z" }));
  store.setDigest("s2", digest({ title: "Caddy deploy", summary: "Deployed via caddy.", topics: ["deploy"] }));
  store.upsertSession(meta("s3")); // undigested
  // Two sessions sharing a distinctive term ("gizmo") but differing outcome,
  // for the search+outcome-filter test — dated before aaa-111/s2 so the
  // newest-first list ordering test above is unaffected.
  store.upsertSession(meta("s4", { projectPath: "D:\\Projects\\other", startedAt: "2026-07-01T10:00:00.000Z" }));
  store.setDigest("s4", digest({ title: "Gizmo work A", summary: "Worked on the gizmo pipeline.", topics: ["gizmo"], outcome: "completed" }));
  store.upsertSession(meta("s5", { projectPath: "D:\\Projects\\other", startedAt: "2026-07-02T10:00:00.000Z" }));
  store.setDigest("s5", digest({ title: "Gizmo work B", summary: "Continued gizmo pipeline work.", topics: ["gizmo"], outcome: "ongoing" }));
  server = createUiServer(store);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

describe("UI API", () => {
  it("GET /api/status reports counts", async () => {
    const { status, body } = await get("/api/status");
    expect(status).toBe(200);
    expect(body).toMatchObject({ sessions: 5, projects: 2, digested: 4, pending: 1, failed: 0 });
    expect(typeof body.dbPath).toBe("string");
  });
  it("GET /api/projects returns per-project stats", async () => {
    const { body } = await get("/api/projects");
    expect(body.length).toBe(2);
    expect(body.find((p: any) => p.projectPath.endsWith("demo")).sessionCount).toBe(2);
  });
  it("GET /api/sessions lists newest-first; with q it searches", async () => {
    const list = await get("/api/sessions");
    expect(list.body.total).toBe(5);
    expect(list.body.rows[0].sessionId).toBe("s2");
    const search = await get("/api/sessions?q=caddy");
    expect(search.body.rows.map((r: any) => r.sessionId)).toEqual(["s2"]);
    expect(search.body.rows[0].snippet).toContain(">>");
  });
  it("GET /api/sessions honors project/outcome filters", async () => {
    const r = await get("/api/sessions?project=other");
    expect(r.body.rows.map((x: any) => x.sessionId).sort()).toEqual(["s2", "s4", "s5"]);
  });
  // Important #1: the search branch (q=...) must also apply outcome/from/to,
  // not just project — previously it silently dropped everything but project.
  it("GET /api/sessions?q=...&outcome=... narrows search results by outcome", async () => {
    const both = await get("/api/sessions?q=gizmo");
    expect(both.body.rows.map((r: any) => r.sessionId).sort()).toEqual(["s4", "s5"]);
    const narrowed = await get("/api/sessions?q=gizmo&outcome=ongoing");
    expect(narrowed.body.rows.map((r: any) => r.sessionId)).toEqual(["s5"]);
  });
  it("GET /api/sessions/:id returns full row, 404 when missing", async () => {
    expect((await get("/api/sessions/aaa-111")).body.digestTitle).toBe("Login fix");
    expect((await get("/api/sessions/nope")).status).toBe(404);
  });
  it("GET /api/sessions/:id/related and /excerpt", async () => {
    expect((await get("/api/sessions/aaa-111/related")).status).toBe(200);
    const ex = await get("/api/sessions/aaa-111/excerpt?q=unescaped");
    expect(ex.status).toBe(200);
    expect(ex.body.snippets[0]).toContain("unescaped");
    expect((await get("/api/sessions/aaa-111/excerpt")).status).toBe(400); // q required
  });
  it("GET /api/graph returns nodes+edges and honors filters", async () => {
    const g = await get("/api/graph");
    expect(g.body.nodes.some((n: any) => n.id === "topic:login")).toBe(true);
    const f = await get("/api/graph?project=other");
    expect(f.body.nodes.some((n: any) => n.id === "topic:login")).toBe(false);
  });
  it("unknown /api route → 404 JSON", async () => {
    const r = await get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBeDefined();
  });
  it("malformed percent-encoding in a param segment doesn't crash the server", async () => {
    const r = await fetch(base + "/api/sessions/%zz");
    expect([400, 404]).toContain(r.status);
    const body = await r.json();
    expect(body.error).toBeDefined();
    // the server process must still be alive and answering afterward
    const follow = await get("/api/status");
    expect(follow.status).toBe(200);
  });
  it("search rows match the list-row shape: digestStatus present, no rank leak", async () => {
    const { body } = await get("/api/sessions?q=caddy");
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows[0]).toHaveProperty("digestStatus");
    expect(body.rows[0]).not.toHaveProperty("rank");
  });
  // DNS-rebinding guard: a request whose Host header doesn't name this local
  // server must be rejected before routing. Node's fetch forbids overriding
  // the Host header, so this uses http.request directly.
  it("rejects requests with a non-local Host header (403 forbidden host)", async () => {
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/status", method: "GET", headers: { Host: "evil.example" } },
        res => { resolve(res.statusCode!); res.resume(); },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
  it("a normal local request is unaffected by the Host-header check", async () => {
    expect((await get("/api/status")).status).toBe(200);
  });
});
