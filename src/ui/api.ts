import { Router, sendJson } from "./router.js";
import type { SessionStore, SessionFilters } from "../store.js";
import { getSessionExcerpt } from "../excerpt.js";
import { dbPath } from "../paths.js";

function filtersFrom(url: URL): SessionFilters {
  const g = (k: string) => url.searchParams.get(k) || undefined;
  return { project: g("project"), outcome: g("outcome"), from: g("from"), to: g("to") };
}
function intParam(url: URL, k: string, def: number, max: number): number {
  const n = parseInt(url.searchParams.get(k) ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : def;
}

export function registerApi(router: Router, store: SessionStore): void {
  router.get("/api/status", (_req, res) => {
    const stats = store.projectStats();
    const sum = (k: "sessionCount" | "digested" | "pending" | "failed") => stats.reduce((n, p) => n + p[k], 0);
    sendJson(res, 200, {
      sessions: sum("sessionCount"), projects: stats.length,
      digested: sum("digested"), pending: sum("pending"), failed: sum("failed"),
      dbPath: dbPath(),
    });
  });

  router.get("/api/projects", (_req, res) => sendJson(res, 200, store.projectStats()));

  router.get("/api/sessions", (_req, res, _p, url) => {
    const f = filtersFrom(url);
    const limit = intParam(url, "limit", 50, 200);
    const offset = intParam(url, "offset", 0, 1_000_000);
    const q = url.searchParams.get("q")?.trim();
    if (q) {
      const hits = store.searchSessions(q, { ...f, limit });
      // Normalize to the same row shape /api/sessions (list mode) returns,
      // so callers don't need to branch on `mode` to read a row.
      const rows = hits.map(h => ({
        sessionId: h.sessionId, projectPath: h.projectPath, title: h.title,
        aiTitle: null, firstPrompt: null, startedAt: h.startedAt,
        outcome: h.outcome, digestStatus: null, snippet: h.snippet,
      }));
      return sendJson(res, 200, { rows, total: rows.length, mode: "search" });
    }
    const { rows, total } = store.listSessions({ ...f, limit, offset });
    sendJson(res, 200, {
      rows: rows.map(r => ({
        sessionId: r.sessionId, projectPath: r.projectPath, title: r.digestTitle,
        aiTitle: r.aiTitle, firstPrompt: r.firstPrompt, startedAt: r.startedAt,
        outcome: r.outcome, digestStatus: r.digestStatus, snippet: r.digestSummary ?? "",
      })),
      total, mode: "list",
    });
  });

  router.get("/api/sessions/:id", (_req, res, p) => {
    const row = store.getSession(p.id);
    if (!row) return sendJson(res, 404, { error: "session not found" });
    sendJson(res, 200, row);
  });

  router.get("/api/sessions/:id/related", (_req, res, p) => {
    if (!store.getSession(p.id)) return sendJson(res, 404, { error: "session not found" });
    sendJson(res, 200, store.relatedSessions(p.id));
  });

  router.get("/api/sessions/:id/excerpt", (_req, res, p, url) => {
    const row = store.getSession(p.id);
    if (!row) return sendJson(res, 404, { error: "session not found" });
    const q = url.searchParams.get("q")?.trim();
    if (!q) return sendJson(res, 400, { error: "q is required" });
    try { sendJson(res, 200, { snippets: getSessionExcerpt(row.filePath, q) }); }
    catch { sendJson(res, 200, { snippets: [], error: "source transcript missing" }); }
  });

  router.get("/api/graph", (_req, res, _p, url) => sendJson(res, 200, store.graphData(filtersFrom(url))));
}
