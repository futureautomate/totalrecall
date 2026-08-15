import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import type { SessionMeta, Digest, SearchResult } from "./types.js";

export interface SessionRow {
  sessionId: string; projectPath: string; filePath: string;
  startedAt: string | null; endedAt: string | null;
  firstPrompt: string | null; aiTitle: string | null; gitBranch: string | null;
  models: string[]; messageCount: number;
  digestStatus: string; digestTitle: string | null; digestSummary: string | null;
  decisions: string[]; outcome: string | null;
  topics: string[]; filesEdited: string[];
}

export interface SessionFilters { project?: string; outcome?: string; from?: string; to?: string; }
export interface GraphNode {
  id: string; type: "session" | "topic" | "project"; label: string;
  project?: string; outcome?: string | null; messageCount?: number; startedAt?: string | null;
}
export interface GraphEdge { source: string; target: string; kind: "about" | "in_project"; }

// Shared WHERE fragment for the UI read methods. Every filter is optional;
// null params make the clause a no-op. `from`/`to` compare ISO strings, which
// is correct for ISO-8601 timestamps.
function filterClause(alias = "s"): { sql: string; params: (f: SessionFilters) => Record<string, unknown> } {
  return {
    sql: `
      (@project IS NULL OR instr(LOWER(${alias}.project_path), LOWER(@project)) > 0)
      AND (@outcome IS NULL OR ${alias}.outcome = @outcome)
      AND (@from IS NULL OR ${alias}.started_at >= @from)
      AND (@to IS NULL OR ${alias}.started_at <= @to)`,
    params: (f) => ({ project: f.project ?? null, outcome: f.outcome ?? null,
      from: f.from ?? null, to: f.to ? f.to + "T99" : null }),
  };
}

function rowFrom(db: Database.Database, r: any): SessionRow {
  const topics = db.prepare("SELECT topic FROM session_topics WHERE session_id = ? ORDER BY rowid")
    .all(r.session_id).map((t: any) => t.topic);
  const files = db.prepare("SELECT file_path FROM session_files WHERE session_id = ? ORDER BY rowid")
    .all(r.session_id).map((f: any) => f.file_path);
  return {
    sessionId: r.session_id, projectPath: r.project_path, filePath: r.file_path,
    startedAt: r.started_at, endedAt: r.ended_at, firstPrompt: r.first_prompt,
    aiTitle: r.ai_title, gitBranch: r.git_branch, models: JSON.parse(r.models),
    messageCount: r.message_count, digestStatus: r.digest_status,
    digestTitle: r.digest_title, digestSummary: r.digest_summary,
    decisions: JSON.parse(r.decisions), outcome: r.outcome,
    topics, filesEdited: files,
  };
}

export function sanitizeFtsQuery(q: string): string {
  const tokens = q.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t}"`).join(" OR ");
}

export class SessionStore {
  db: Database.Database;
  constructor(file: string) { this.db = openDb(file); }

  upsertSession(m: SessionMeta): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sessions (session_id, project_path, file_path, started_at, ended_at,
          first_prompt, ai_title, git_branch, models, message_count, file_mtime_ms,
          file_size, indexed_at)
        VALUES (@sessionId, @projectPath, @filePath, @startedAt, @endedAt, @firstPrompt,
          @aiTitle, @gitBranch, @models, @messageCount, @fileMtimeMs, @fileSize,
          datetime('now'))
        ON CONFLICT(session_id) DO UPDATE SET
          project_path=@projectPath, file_path=@filePath, started_at=@startedAt,
          ended_at=@endedAt, first_prompt=@firstPrompt, ai_title=@aiTitle,
          git_branch=@gitBranch, models=@models, message_count=@messageCount,
          file_mtime_ms=@fileMtimeMs, file_size=@fileSize, indexed_at=datetime('now'),
          -- A changed file (different mtime/size than what's stored) means the
          -- transcript grew/mutated since it was last digested: the stored
          -- digest text is now stale, so force a re-digest by flipping status
          -- back to pending. Old digest_title/summary/decisions/outcome are
          -- left in place (still shown) until the re-digest overwrites them.
          digest_status = CASE
            WHEN file_mtime_ms != @fileMtimeMs OR file_size != @fileSize THEN 'pending'
            ELSE digest_status
          END
      `).run({
        sessionId: m.sessionId,
        projectPath: m.projectPath,
        filePath: m.filePath,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        firstPrompt: m.firstPrompt,
        aiTitle: m.aiTitle,
        gitBranch: m.gitBranch,
        models: JSON.stringify(m.models),
        messageCount: m.messageCount,
        fileMtimeMs: m.fileMtimeMs,
        fileSize: m.fileSize,
      });
      this.db.prepare("DELETE FROM session_files WHERE session_id = ?").run(m.sessionId);
      const insFile = this.db.prepare("INSERT OR IGNORE INTO session_files VALUES (?, ?)");
      for (const f of m.filesEdited) insFile.run(m.sessionId, f);
      // Undigested sessions were previously invisible to search: session_fts
      // only ever got a row from setDigest(). Give every session a baseline
      // FTS row here (searchable on title/first-prompt) so search works even
      // before (or if never) digested.
      //
      // But don't do this unconditionally: a session that's already digested
      // ('done') keeps its rich digest-based FTS row (title/summary/decisions/
      // topics) — re-upserting an unchanged, already-digested session (e.g. a
      // duplicate hook-run firing) must not clobber it back down to the bare
      // title+first_prompt baseline. Only reseed when the resolved status is
      // NOT 'done' — which includes the fresh-insert case (status defaults to
      // 'pending') and the fix-#3 case where a changed file just flipped
      // status back to 'pending' (that case *should* reseed: the digest text
      // is now stale too).
      const status: any = this.db.prepare(
        "SELECT digest_status FROM sessions WHERE session_id = ?").get(m.sessionId);
      if (status?.digest_status !== "done") {
        this.db.prepare("DELETE FROM session_fts WHERE session_id = ?").run(m.sessionId);
        this.db.prepare("INSERT INTO session_fts VALUES (?, ?, ?, ?, ?, ?)")
          .run(m.sessionId, m.aiTitle ?? "", "", "", m.firstPrompt ?? "", "");
      }
    });
    tx();
  }

  setDigest(sessionId: string, d: Digest): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE sessions SET digest_status='done', digest_title=?, digest_summary=?,
          decisions=?, outcome=? WHERE session_id=?
      `).run(d.title, d.summary, JSON.stringify(d.decisions), d.outcome, sessionId);
      this.db.prepare("DELETE FROM session_topics WHERE session_id = ?").run(sessionId);
      const insTopic = this.db.prepare("INSERT OR IGNORE INTO session_topics VALUES (?, ?)");
      for (const t of d.topics) insTopic.run(sessionId, t.toLowerCase());
      // refresh FTS row
      this.db.prepare("DELETE FROM session_fts WHERE session_id = ?").run(sessionId);
      const row: any = this.db.prepare("SELECT first_prompt FROM sessions WHERE session_id=?").get(sessionId);
      this.db.prepare("INSERT INTO session_fts VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionId, d.title, d.summary, d.decisions.join(" | "),
             row?.first_prompt ?? "", d.topics.join(" "));
    });
    tx();
  }

  markDigestFailed(sessionId: string): void {
    this.db.prepare("UPDATE sessions SET digest_status='failed' WHERE session_id=?").run(sessionId);
  }

  getSession(sessionId: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    return r ? rowFrom(this.db, r) : undefined;
  }

  isUnchanged(filePath: string, mtimeMs: number, size: number): boolean {
    const r: any = this.db.prepare(
      "SELECT file_mtime_ms, file_size FROM sessions WHERE file_path = ?").get(filePath);
    return !!r && r.file_mtime_ms === mtimeMs && r.file_size === size;
  }

  sessionsNeedingDigest(limit = 1000): SessionRow[] {
    return this.db.prepare(
      "SELECT * FROM sessions WHERE digest_status IN ('pending','failed') ORDER BY started_at LIMIT ?")
      .all(limit).map((r) => rowFrom(this.db, r));
  }

  searchSessions(query: string, opts: { project?: string; limit?: number } = {}): SearchResult[] {
    const limit = opts.limit ?? 10;
    const fts = sanitizeFtsQuery(query);
    const rows: any[] = this.db.prepare(`
      SELECT s.session_id, s.project_path, s.digest_title, s.started_at, s.outcome,
             snippet(session_fts, 2, '>>', '<<', ' … ', 24) AS snip,
             bm25(session_fts) AS rank
      FROM session_fts JOIN sessions s ON s.session_id = session_fts.session_id
      WHERE session_fts MATCH ?
        AND (@project IS NULL OR instr(LOWER(s.project_path), LOWER(@project)) > 0)
      ORDER BY rank LIMIT @limit
    `).all(fts, { project: opts.project ?? null, limit });
    return rows.map(r => ({
      sessionId: r.session_id, projectPath: r.project_path, title: r.digest_title,
      snippet: r.snip ?? "", startedAt: r.started_at, outcome: r.outcome, rank: r.rank,
    }));
  }

  listProjects(): { projectPath: string; sessionCount: number; lastActivity: string | null }[] {
    return this.db.prepare(`
      SELECT project_path AS projectPath, COUNT(*) AS sessionCount,
             MAX(ended_at) AS lastActivity
      FROM sessions GROUP BY project_path ORDER BY lastActivity DESC
    `).all() as any[];
  }

  relatedSessions(sessionId: string): { sessionId: string; title: string | null; reason: string }[] {
    // Ranked by overlap (most shared files/topics first) and capped per
    // branch so a session that shares one file/topic with hundreds of others
    // can't blow up the result set.
    const RELATED_PER_BRANCH_LIMIT = 15;
    const RELATED_TOTAL_CAP = 25;
    const byFile: any[] = this.db.prepare(`
      SELECT sf2.session_id AS id, s.digest_title AS title, COUNT(*) AS cnt
      FROM session_files sf1
      JOIN session_files sf2 ON sf1.file_path = sf2.file_path AND sf2.session_id != sf1.session_id
      JOIN sessions s ON s.session_id = sf2.session_id
      WHERE sf1.session_id = ?
      GROUP BY sf2.session_id
      ORDER BY cnt DESC
      LIMIT ?
    `).all(sessionId, RELATED_PER_BRANCH_LIMIT);
    const byTopic: any[] = this.db.prepare(`
      SELECT st2.session_id AS id, s.digest_title AS title, COUNT(*) AS cnt
      FROM session_topics st1
      JOIN session_topics st2 ON st1.topic = st2.topic AND st2.session_id != st1.session_id
      JOIN sessions s ON s.session_id = st2.session_id
      WHERE st1.session_id = ?
      GROUP BY st2.session_id
      ORDER BY cnt DESC
      LIMIT ?
    `).all(sessionId, RELATED_PER_BRANCH_LIMIT);
    const byChain: any[] = this.db.prepare(`
      SELECT to_id AS id, 'continuation' AS why FROM session_continues WHERE from_id = ?
      UNION SELECT from_id AS id, 'continuation' FROM session_continues WHERE to_id = ?
    `).all(sessionId, sessionId);

    const out = new Map<string, { sessionId: string; title: string | null; reason: string }>();
    // Continuation entries are always kept, uncapped.
    for (const r of byChain) out.set(r.id, { sessionId: r.id, title: null, reason: "continuation" });

    let budget = Math.max(0, RELATED_TOTAL_CAP - out.size);
    for (const r of byFile) {
      if (out.has(r.id)) continue;
      if (budget <= 0) break;
      out.set(r.id, { sessionId: r.id, title: r.title, reason: `shares ${r.cnt} file${r.cnt === 1 ? "" : "s"}` });
      budget--;
    }
    for (const r of byTopic) {
      if (out.has(r.id)) continue;
      if (budget <= 0) break;
      out.set(r.id, { sessionId: r.id, title: r.title, reason: `shares ${r.cnt} topic${r.cnt === 1 ? "" : "s"}` });
      budget--;
    }
    return [...out.values()];
  }

  listSessions(f: SessionFilters & { limit?: number; offset?: number } = {}): { rows: SessionRow[]; total: number } {
    const fc = filterClause();
    const params = fc.params(f);
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM sessions s WHERE ${fc.sql}`)
      .get(params) as any).n as number;
    const rows = this.db.prepare(`
      SELECT * FROM sessions s WHERE ${fc.sql}
      ORDER BY s.started_at DESC, s.session_id LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: f.limit ?? 50, offset: f.offset ?? 0 })
      .map((r) => rowFrom(this.db, r));
    return { rows, total };
  }

  projectStats(): { projectPath: string; sessionCount: number; lastActivity: string | null;
                    digested: number; pending: number; failed: number; topTopics: string[] }[] {
    const rows: any[] = this.db.prepare(`
      SELECT project_path AS projectPath, COUNT(*) AS sessionCount, MAX(ended_at) AS lastActivity,
        SUM(CASE WHEN digest_status = 'done' THEN 1 ELSE 0 END) AS digested,
        SUM(CASE WHEN digest_status IN ('pending','skipped') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN digest_status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM sessions GROUP BY project_path ORDER BY lastActivity DESC
    `).all();
    const topTopicsStmt = this.db.prepare(`
      SELECT st.topic, COUNT(*) AS n FROM session_topics st
      JOIN sessions s ON s.session_id = st.session_id
      WHERE s.project_path = ? GROUP BY st.topic ORDER BY n DESC, st.topic LIMIT 3
    `);
    return rows.map(r => ({ ...r, topTopics: topTopicsStmt.all(r.projectPath).map((t: any) => t.topic) }));
  }

  graphData(f: SessionFilters = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const fc = filterClause();
    const params = fc.params(f);
    const sessions: any[] = this.db.prepare(`
      SELECT session_id, project_path, digest_title, ai_title, first_prompt, outcome,
             message_count, started_at FROM sessions s WHERE ${fc.sql}
    `).all(params);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const projects = new Set<string>();
    const topics = new Set<string>();
    for (const s of sessions) {
      nodes.push({
        id: s.session_id, type: "session",
        label: s.digest_title ?? s.ai_title ?? (s.first_prompt ?? s.session_id).slice(0, 60),
        project: s.project_path, outcome: s.outcome, messageCount: s.message_count, startedAt: s.started_at,
      });
      projects.add(s.project_path);
      edges.push({ source: s.session_id, target: `project:${s.project_path}`, kind: "in_project" });
    }
    if (sessions.length > 0) {
      const ids = sessions.map(s => s.session_id);
      const placeholders = ids.map(() => "?").join(",");
      const links: any[] = this.db.prepare(
        `SELECT session_id, topic FROM session_topics WHERE session_id IN (${placeholders})`).all(...ids);
      for (const l of links) {
        topics.add(l.topic);
        edges.push({ source: l.session_id, target: `topic:${l.topic}`, kind: "about" });
      }
    }
    for (const p of projects) nodes.push({ id: `project:${p}`, type: "project", label: p });
    for (const t of topics) nodes.push({ id: `topic:${t}`, type: "topic", label: t });
    return { nodes, edges };
  }

  close(): void { this.db.close(); }
}
