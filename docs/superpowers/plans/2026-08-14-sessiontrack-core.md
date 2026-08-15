# sessiontrack Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the sessiontrack core: scan all Claude Code session JSONL files machine-wide, index them into SQLite with FTS5 search, generate LLM digests via headless `claude -p`, and expose the knowledge through a CLI, an MCP server, and a SessionEnd hook.

**Architecture:** A single TypeScript/Node package. A mechanical parser extracts metadata from session JSONL; a digester distills each session via `claude -p` (Haiku); everything lands in one SQLite database (WAL, FTS5). The CLI (`index`, `backfill`, `search`, `mcp`, `install-hook`) and the MCP server are thin layers over a shared store module. Web UI and Neo4j export are separate later plans.

**Tech Stack:** Node 22, TypeScript (ESM), better-sqlite3, commander, @modelcontextprotocol/sdk, zod, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-08-13-sessiontrack-design.md`

## Global Constraints

- **NO git commits.** The user has explicitly forbidden git init/commit/push until they say otherwise. Every "Commit" step normal to this workflow is replaced by "mark step done". Do not run any `git` command.
- Data directory: `~/.sessiontrack/` (database at `~/.sessiontrack/index.db`).
- Session source: `~/.claude/projects/<encoded-path>/<session-id>.jsonl` (encoding: path with `:` `\` `/` replaced by `-`, e.g. `D--Projects-sessiontrack`).
- Digest model: `claude-haiku-4-5`, invoked as `claude -p --output-format json` with the prompt piped via stdin (Windows arg-length limits forbid passing transcripts as arguments).
- The digester must run `claude` with cwd set to `~/.sessiontrack/digester-cwd/` and the scanner must exclude that directory's encoded project dir — otherwise digest runs create sessions that get indexed, recursively.
- Never crash on malformed/unknown JSONL lines: log and skip.
- The currently-active session (file mtime < 2 minutes old) is skipped by indexing.
- All code ESM (`"type": "module"`); tests with vitest; run TypeScript directly with tsx.
- Windows is the primary platform: always use `path.join`, never hardcode `/`.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/types.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: the `SessionMeta`, `Digest`, `CondensedMessage` types every later task imports from `src/types.ts`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "sessiontrack",
  "version": "0.1.0",
  "description": "Machine-wide Claude Code session knowledge base: index, search, MCP",
  "type": "module",
  "bin": { "sessiontrack": "./dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```
npm install better-sqlite3 commander zod @modelcontextprotocol/sdk
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Create vitest.config.ts and .gitignore**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
```

`.gitignore`:
```
node_modules/
dist/
*.db
```

- [ ] **Step 5: Create src/types.ts**

```ts
export interface SessionMeta {
  sessionId: string;
  projectPath: string;      // decoded real path, e.g. D:\Projects\sessiontrack
  filePath: string;         // absolute path to the .jsonl
  startedAt: string | null; // ISO timestamp
  endedAt: string | null;
  firstPrompt: string | null; // first real (non-meta) user message, truncated to 500 chars
  aiTitle: string | null;
  gitBranch: string | null;
  models: string[];
  messageCount: number;       // user + assistant lines
  filesEdited: string[];      // absolute paths from Edit/Write/NotebookEdit tool calls
  fileMtimeMs: number;
  fileSize: number;
}

export interface CondensedMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ParsedSession {
  meta: SessionMeta;
  condensed: CondensedMessage[]; // for the digester; each text truncated to 2000 chars
}

export interface Digest {
  title: string;
  summary: string;          // 3–6 sentences
  decisions: string[];
  outcome: "completed" | "ongoing" | "abandoned";
  topics: string[];         // 3–8 lowercase tags
}

export type DigestStatus = "pending" | "done" | "failed" | "skipped";

export interface SearchResult {
  sessionId: string;
  projectPath: string;
  title: string | null;
  snippet: string;
  startedAt: string | null;
  outcome: string | null;
  rank: number;
}
```

- [ ] **Step 6: Write smoke test and verify toolchain**

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import type { SessionMeta } from "../src/types.js";

describe("scaffold", () => {
  it("types are importable", () => {
    const m: Partial<SessionMeta> = { sessionId: "x" };
    expect(m.sessionId).toBe("x");
  });
});
```

Run: `npm test`
Expected: PASS (1 test). Also run `npx tsc --noEmit` — expected: no errors.

---

### Task 2: Paths module — locating and decoding session storage

**Files:**
- Create: `src/paths.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Produces:
  - `claudeProjectsDir(): string` — `~/.claude/projects`
  - `dataDir(): string` — `~/.sessiontrack` (created if missing)
  - `dbPath(): string` — `~/.sessiontrack/index.db`
  - `digesterCwd(): string` — `~/.sessiontrack/digester-cwd` (created if missing)
  - `encodeProjectPath(realPath: string): string` — real path → encoded dir name
  - `excludedProjectDirs(): Set<string>` — encoded dir names the scanner must skip

- [ ] **Step 1: Write failing tests**

`tests/paths.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { encodeProjectPath, excludedProjectDirs, claudeProjectsDir } from "../src/paths.js";
import os from "node:os";
import path from "node:path";

describe("paths", () => {
  it("encodes a Windows path the way Claude Code does", () => {
    expect(encodeProjectPath("D:\\Projects\\sessiontrack")).toBe("D--Projects-sessiontrack");
    expect(encodeProjectPath("C:\\Users\\tejas")).toBe("C--Users-tejas");
  });
  it("claudeProjectsDir points into the home directory", () => {
    expect(claudeProjectsDir()).toBe(path.join(os.homedir(), ".claude", "projects"));
  });
  it("excludes the digester cwd from scanning", () => {
    const digesterEncoded = encodeProjectPath(path.join(os.homedir(), ".sessiontrack", "digester-cwd"));
    expect(excludedProjectDirs().has(digesterEncoded)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/paths.test.ts`
Expected: FAIL — cannot resolve `../src/paths.js`.

- [ ] **Step 3: Implement src/paths.ts**

```ts
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function dataDir(): string {
  const d = path.join(os.homedir(), ".sessiontrack");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function dbPath(): string {
  return path.join(dataDir(), "index.db");
}

export function digesterCwd(): string {
  const d = path.join(dataDir(), "digester-cwd");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Claude Code encodes a project path into a directory name by replacing
// every character that is not [A-Za-z0-9-] with "-" (":", "\", "/", ".", etc).
export function encodeProjectPath(realPath: string): string {
  return realPath.replace(/[^A-Za-z0-9-]/g, "-");
}

export function excludedProjectDirs(): Set<string> {
  return new Set([encodeProjectPath(path.join(os.homedir(), ".sessiontrack", "digester-cwd"))]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/paths.test.ts`
Expected: PASS (3 tests).

Note: decoding an encoded dir name back to a real path is ambiguous (`-` is lossy), so we never decode — the parser reads the real `cwd` field from inside each session file instead.

---

### Task 3: Session parser

**Files:**
- Create: `src/parser.ts`, `tests/fixtures/basic-session.jsonl`, `tests/fixtures/messy-session.jsonl`
- Test: `tests/parser.test.ts`

**Interfaces:**
- Consumes: `ParsedSession`, `SessionMeta`, `CondensedMessage` from `src/types.js`.
- Produces: `parseSessionFile(filePath: string): ParsedSession` (sync; reads whole file).

- [ ] **Step 1: Create fixture files**

`tests/fixtures/basic-session.jsonl` (one JSON object per line — keep each on ONE line in the real file):
```jsonl
{"type":"mode","mode":"normal","sessionId":"aaa-111"}
{"type":"ai-title","aiTitle":"Fix login bug","sessionId":"aaa-111"}
{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>caveat text</local-command-caveat>"},"uuid":"u0","timestamp":"2026-08-01T10:00:00.000Z","cwd":"D:\\Projects\\demo","sessionId":"aaa-111","gitBranch":"main","version":"2.1.229"}
{"type":"user","message":{"role":"user","content":"The login page throws a 500 when the password has a quote in it"},"uuid":"u1","timestamp":"2026-08-01T10:00:05.000Z","cwd":"D:\\Projects\\demo","sessionId":"aaa-111","gitBranch":"main","version":"2.1.229"}
{"type":"assistant","message":{"role":"assistant","model":"claude-fable-5","content":[{"type":"text","text":"I'll look at the login handler."},{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"D:\\Projects\\demo\\src\\login.ts","old_string":"a","new_string":"b"}}]},"uuid":"a1","timestamp":"2026-08-01T10:00:10.000Z","cwd":"D:\\Projects\\demo","sessionId":"aaa-111","gitBranch":"main"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"uuid":"u2","timestamp":"2026-08-01T10:00:12.000Z","cwd":"D:\\Projects\\demo","sessionId":"aaa-111","gitBranch":"main"}
{"type":"assistant","message":{"role":"assistant","model":"claude-fable-5","content":[{"type":"text","text":"Fixed: the SQL string was unescaped. Escaping added."}]},"uuid":"a2","timestamp":"2026-08-01T10:01:00.000Z","cwd":"D:\\Projects\\demo","sessionId":"aaa-111","gitBranch":"main"}
```

`tests/fixtures/messy-session.jsonl`:
```jsonl
{"type":"unknown-future-type","payload":{"deep":true},"sessionId":"bbb-222"}
this line is not json at all {{{
{"type":"user","message":{"role":"user","content":"hello from messy session"},"uuid":"u1","timestamp":"2026-08-02T09:00:00.000Z","cwd":"D:\\Projects\\demo2","sessionId":"bbb-222"}
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"tool_use","id":"t9","name":"Write","input":{"file_path":"D:\\Projects\\demo2\\a.txt","content":"x"}}]},"uuid":"a1","timestamp":"2026-08-02T09:00:20.000Z","cwd":"D:\\Projects\\demo2","sessionId":"bbb-222"}
```

- [ ] **Step 2: Write failing tests**

`tests/parser.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseSessionFile } from "../src/parser.js";
import path from "node:path";

const fx = (f: string) => path.join(__dirname, "fixtures", f);

describe("parseSessionFile", () => {
  it("extracts metadata from a clean session", () => {
    const { meta, condensed } = parseSessionFile(fx("basic-session.jsonl"));
    expect(meta.sessionId).toBe("aaa-111");
    expect(meta.projectPath).toBe("D:\\Projects\\demo");
    expect(meta.aiTitle).toBe("Fix login bug");
    expect(meta.firstPrompt).toContain("login page throws a 500");
    expect(meta.firstPrompt).not.toContain("caveat");         // isMeta lines skipped
    expect(meta.gitBranch).toBe("main");
    expect(meta.models).toEqual(["claude-fable-5"]);
    expect(meta.filesEdited).toEqual(["D:\\Projects\\demo\\src\\login.ts"]);
    expect(meta.startedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(meta.endedAt).toBe("2026-08-01T10:01:00.000Z");
    expect(meta.messageCount).toBe(5);                        // user+assistant lines
    // condensed: only human-meaningful text, no tool_result noise
    expect(condensed.some(m => m.text.includes("SQL string was unescaped"))).toBe(true);
    expect(condensed.every(m => m.text.length <= 2000)).toBe(true);
  });

  it("survives malformed and unknown lines", () => {
    const { meta } = parseSessionFile(fx("messy-session.jsonl"));
    expect(meta.sessionId).toBe("bbb-222");
    expect(meta.projectPath).toBe("D:\\Projects\\demo2");
    expect(meta.filesEdited).toEqual(["D:\\Projects\\demo2\\a.txt"]);
    expect(meta.models).toEqual(["claude-sonnet-5"]);
  });
});
```

Note: vitest with ESM — `__dirname` is unavailable. Use:
```ts
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/parser.test.ts`
Expected: FAIL — cannot resolve `../src/parser.js`.

- [ ] **Step 4: Implement src/parser.ts**

```ts
import fs from "node:fs";
import path from "node:path";
import type { ParsedSession, SessionMeta, CondensedMessage } from "./types.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const MAX_CONDENSED_CHARS = 2000;
const MAX_FIRST_PROMPT = 500;

function textOfContent(content: unknown): string {
  // message.content is either a string or an array of {type, text?, ...} blocks
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

export function parseSessionFile(filePath: string): ParsedSession {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, "utf8");
  const meta: SessionMeta = {
    sessionId: path.basename(filePath, ".jsonl"),
    projectPath: "",
    filePath,
    startedAt: null,
    endedAt: null,
    firstPrompt: null,
    aiTitle: null,
    gitBranch: null,
    models: [],
    messageCount: 0,
    filesEdited: [],
    fileMtimeMs: stat.mtimeMs,
    fileSize: stat.size,
  };
  const condensed: CondensedMessage[] = [];
  const models = new Set<string>();
  const files = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; } // malformed line: skip
    if (!obj || typeof obj !== "object") continue;

    if (obj.sessionId && !meta.projectPath && typeof obj.cwd === "string") meta.projectPath = obj.cwd;
    if (obj.type === "ai-title" && typeof obj.aiTitle === "string") meta.aiTitle = obj.aiTitle;

    if (obj.type !== "user" && obj.type !== "assistant") continue;
    meta.messageCount++;
    if (typeof obj.timestamp === "string") {
      if (!meta.startedAt) meta.startedAt = obj.timestamp;
      meta.endedAt = obj.timestamp;
    }
    if (typeof obj.gitBranch === "string" && obj.gitBranch && obj.gitBranch !== "HEAD") {
      meta.gitBranch = obj.gitBranch;
    }

    if (obj.type === "user" && !obj.isMeta) {
      const text = textOfContent(obj.message?.content);
      if (text) {
        if (!meta.firstPrompt) meta.firstPrompt = text.slice(0, MAX_FIRST_PROMPT);
        condensed.push({ role: "user", text: text.slice(0, MAX_CONDENSED_CHARS) });
      }
    }

    if (obj.type === "assistant") {
      const model = obj.message?.model;
      if (typeof model === "string") models.add(model);
      const text = textOfContent(obj.message?.content);
      if (text) condensed.push({ role: "assistant", text: text.slice(0, MAX_CONDENSED_CHARS) });
      const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
      for (const b of blocks) {
        if (b?.type === "tool_use" && EDIT_TOOLS.has(b.name) && typeof b.input?.file_path === "string") {
          files.add(b.input.file_path);
        }
      }
    }
  }

  meta.models = [...models];
  meta.filesEdited = [...files];
  return { meta, condensed };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/parser.test.ts`
Expected: PASS (2 tests). If `messageCount` assertion fails, count the fixture's user+assistant lines and fix whichever side is wrong (the meta caveat line IS type user, so it counts; expected value in the fixture above is 5: u0, u1, a1, u2, a2).

---

### Task 4: Store — schema and upserts

**Files:**
- Create: `src/db.ts`, `src/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `SessionMeta`, `Digest`, `DigestStatus` from types; `dbPath()` from paths.
- Produces (class `SessionStore`):
  - `new SessionStore(dbFile: string)` — pass `":memory:"` in tests
  - `upsertSession(meta: SessionMeta): void`
  - `setDigest(sessionId: string, digest: Digest): void`
  - `markDigestFailed(sessionId: string): void`
  - `getSession(sessionId: string): SessionRow | undefined`
  - `isUnchanged(filePath: string, mtimeMs: number, size: number): boolean`
  - `sessionsNeedingDigest(limit?: number): SessionRow[]`
  - `close(): void`
- `SessionRow` = flat DB row: all SessionMeta scalar fields + `digestStatus`, `digestTitle`, `digestSummary`, `decisions: string[]`, `topics: string[]`, `filesEdited: string[]`, `outcome`.

- [ ] **Step 1: Write failing tests**

`tests/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../src/store.js";
import type { SessionMeta, Digest } from "../src/types.js";

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s1", projectPath: "D:\\Projects\\demo", filePath: "C:\\fake\\s1.jsonl",
    startedAt: "2026-08-01T10:00:00.000Z", endedAt: "2026-08-01T11:00:00.000Z",
    firstPrompt: "fix the login bug", aiTitle: "Fix login bug", gitBranch: "main",
    models: ["claude-fable-5"], messageCount: 5,
    filesEdited: ["D:\\Projects\\demo\\src\\login.ts"],
    fileMtimeMs: 1000, fileSize: 2000, ...over,
  };
}

const digest: Digest = {
  title: "Login 500 fix", summary: "Fixed a 500 caused by unescaped quotes in passwords.",
  decisions: ["Escape SQL strings at the boundary"], outcome: "completed",
  topics: ["login", "sql", "bugfix"],
};

describe("SessionStore", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(":memory:"); });

  it("upserts and reads back a session", () => {
    store.upsertSession(meta());
    const row = store.getSession("s1")!;
    expect(row.projectPath).toBe("D:\\Projects\\demo");
    expect(row.digestStatus).toBe("pending");
    expect(row.filesEdited).toEqual(["D:\\Projects\\demo\\src\\login.ts"]);
  });

  it("upsert twice does not duplicate and refreshes fields", () => {
    store.upsertSession(meta());
    store.upsertSession(meta({ messageCount: 9, fileMtimeMs: 3000 }));
    const row = store.getSession("s1")!;
    expect(row.messageCount).toBe(9);
  });

  it("isUnchanged matches on path+mtime+size", () => {
    store.upsertSession(meta());
    expect(store.isUnchanged("C:\\fake\\s1.jsonl", 1000, 2000)).toBe(true);
    expect(store.isUnchanged("C:\\fake\\s1.jsonl", 1001, 2000)).toBe(false);
    expect(store.isUnchanged("C:\\other.jsonl", 1000, 2000)).toBe(false);
  });

  it("setDigest stores digest and flips status; topics readable back", () => {
    store.upsertSession(meta());
    store.setDigest("s1", digest);
    const row = store.getSession("s1")!;
    expect(row.digestStatus).toBe("done");
    expect(row.digestTitle).toBe("Login 500 fix");
    expect(row.topics).toEqual(["login", "sql", "bugfix"]);
    expect(row.outcome).toBe("completed");
  });

  it("sessionsNeedingDigest lists pending and failed only", () => {
    store.upsertSession(meta());
    store.upsertSession(meta({ sessionId: "s2", filePath: "C:\\fake\\s2.jsonl" }));
    store.setDigest("s1", digest);
    const need = store.sessionsNeedingDigest();
    expect(need.map(r => r.sessionId)).toEqual(["s2"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — cannot resolve `../src/store.js`.

- [ ] **Step 3: Implement src/db.ts (schema)**

```ts
import Database from "better-sqlite3";

export function openDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id     TEXT PRIMARY KEY,
      project_path   TEXT NOT NULL,
      file_path      TEXT NOT NULL,
      started_at     TEXT,
      ended_at       TEXT,
      first_prompt   TEXT,
      ai_title       TEXT,
      git_branch     TEXT,
      models         TEXT NOT NULL DEFAULT '[]',
      message_count  INTEGER NOT NULL DEFAULT 0,
      file_mtime_ms  INTEGER NOT NULL DEFAULT 0,
      file_size      INTEGER NOT NULL DEFAULT 0,
      digest_status  TEXT NOT NULL DEFAULT 'pending',
      digest_title   TEXT,
      digest_summary TEXT,
      decisions      TEXT NOT NULL DEFAULT '[]',
      outcome        TEXT,
      source_missing INTEGER NOT NULL DEFAULT 0,
      indexed_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS session_files (
      session_id TEXT NOT NULL,
      file_path  TEXT NOT NULL,
      PRIMARY KEY (session_id, file_path)
    );
    CREATE TABLE IF NOT EXISTS session_topics (
      session_id TEXT NOT NULL,
      topic      TEXT NOT NULL,
      PRIMARY KEY (session_id, topic)
    );
    CREATE TABLE IF NOT EXISTS session_continues (
      from_id TEXT NOT NULL,
      to_id   TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      session_id UNINDEXED, title, summary, decisions, first_prompt, topics
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
  `);
  return db;
}
```

- [ ] **Step 4: Implement src/store.ts**

```ts
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import type { SessionMeta, Digest } from "./types.js";

export interface SessionRow {
  sessionId: string; projectPath: string; filePath: string;
  startedAt: string | null; endedAt: string | null;
  firstPrompt: string | null; aiTitle: string | null; gitBranch: string | null;
  models: string[]; messageCount: number;
  digestStatus: string; digestTitle: string | null; digestSummary: string | null;
  decisions: string[]; outcome: string | null;
  topics: string[]; filesEdited: string[];
}

function rowFrom(db: Database.Database, r: any): SessionRow {
  const topics = db.prepare("SELECT topic FROM session_topics WHERE session_id = ?")
    .all(r.session_id).map((t: any) => t.topic);
  const files = db.prepare("SELECT file_path FROM session_files WHERE session_id = ?")
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
          file_mtime_ms=@fileMtimeMs, file_size=@fileSize, indexed_at=datetime('now')
      `).run({
        ...m, models: JSON.stringify(m.models),
      } as any);
      this.db.prepare("DELETE FROM session_files WHERE session_id = ?").run(m.sessionId);
      const insFile = this.db.prepare("INSERT OR IGNORE INTO session_files VALUES (?, ?)");
      for (const f of m.filesEdited) insFile.run(m.sessionId, f);
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

  close(): void { this.db.close(); }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (5 tests). Watch: better-sqlite3 is a native module — if install failed earlier, `npm rebuild better-sqlite3` and re-run.

---

### Task 5: Search and graph queries

**Files:**
- Modify: `src/store.ts` (add methods)
- Test: `tests/search.test.ts`

**Interfaces:**
- Produces (on `SessionStore`):
  - `searchSessions(query: string, opts?: { project?: string; limit?: number }): SearchResult[]`
  - `listProjects(): { projectPath: string; sessionCount: number; lastActivity: string | null }[]`
  - `relatedSessions(sessionId: string): { sessionId: string; title: string | null; reason: string }[]`
  - `sanitizeFtsQuery(q: string): string` (exported standalone from store.ts)

- [ ] **Step 1: Write failing tests**

`tests/search.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/search.test.ts`
Expected: FAIL — `sanitizeFtsQuery` / `searchSessions` not exported.

- [ ] **Step 3: Implement the methods in src/store.ts**

```ts
// standalone export
export function sanitizeFtsQuery(q: string): string {
  const tokens = q.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t}"`).join(" OR ");
}
```

Methods on `SessionStore`:
```ts
searchSessions(query: string, opts: { project?: string; limit?: number } = {}): SearchResult[] {
  const limit = opts.limit ?? 10;
  const fts = sanitizeFtsQuery(query);
  const rows: any[] = this.db.prepare(`
    SELECT s.session_id, s.project_path, s.digest_title, s.started_at, s.outcome,
           snippet(session_fts, 2, '>>', '<<', ' … ', 24) AS snip,
           bm25(session_fts) AS rank
    FROM session_fts JOIN sessions s ON s.session_id = session_fts.session_id
    WHERE session_fts MATCH ?
      AND (@project IS NULL OR s.project_path = @project)
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
  const byFile: any[] = this.db.prepare(`
    SELECT DISTINCT sf2.session_id AS id, s.digest_title AS title, sf1.file_path AS fp
    FROM session_files sf1
    JOIN session_files sf2 ON sf1.file_path = sf2.file_path AND sf2.session_id != sf1.session_id
    JOIN sessions s ON s.session_id = sf2.session_id
    WHERE sf1.session_id = ?
  `).all(sessionId);
  const byTopic: any[] = this.db.prepare(`
    SELECT DISTINCT st2.session_id AS id, s.digest_title AS title, st1.topic AS tp
    FROM session_topics st1
    JOIN session_topics st2 ON st1.topic = st2.topic AND st2.session_id != st1.session_id
    JOIN sessions s ON s.session_id = st2.session_id
    WHERE st1.session_id = ?
  `).all(sessionId);
  const byChain: any[] = this.db.prepare(`
    SELECT to_id AS id, 'continuation' AS why FROM session_continues WHERE from_id = ?
    UNION SELECT from_id AS id, 'continuation' FROM session_continues WHERE to_id = ?
  `).all(sessionId, sessionId);
  const out = new Map<string, { sessionId: string; title: string | null; reason: string }>();
  for (const r of byChain) out.set(r.id, { sessionId: r.id, title: null, reason: "continuation" });
  for (const r of byFile) if (!out.has(r.id)) out.set(r.id, { sessionId: r.id, title: r.title, reason: `shares file ${r.fp}` });
  for (const r of byTopic) if (!out.has(r.id)) out.set(r.id, { sessionId: r.id, title: r.title, reason: `shares topic ${r.tp}` });
  return [...out.values()];
}
```

Note on the SQL: better-sqlite3 supports mixing positional and named parameters only when passed as (positional..., objectForNamed) — exactly the call shape shown for `searchSessions`. If it errors with "Too few parameter values", switch fully to named params including the MATCH term.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/search.test.ts`
Expected: PASS (6 tests).

---

### Task 6: Digester — prompt, JSON extraction, chunking (claude mocked)

**Files:**
- Create: `src/digester.ts`
- Test: `tests/digester.test.ts`

**Interfaces:**
- Consumes: `CondensedMessage`, `Digest` from types.
- Produces:
  - `type ClaudeRunner = (prompt: string) => Promise<string>` — returns the model's raw text reply
  - `digestSession(condensed: CondensedMessage[], run: ClaudeRunner): Promise<Digest>`
  - `extractJson(text: string): any` — tolerant JSON extraction (fences, prose around it)
  - `CHUNK_CHAR_LIMIT = 48_000`
- Task 7 provides the real `ClaudeRunner`; tests here use fakes.

- [ ] **Step 1: Write failing tests**

`tests/digester.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { digestSession, extractJson, CHUNK_CHAR_LIMIT } from "../src/digester.js";
import type { CondensedMessage } from "../src/types.js";

const validDigestJson = JSON.stringify({
  title: "Auth work", summary: "Did auth things across the session in detail.",
  decisions: ["use JWT"], outcome: "completed", topics: ["auth", "jwt", "api"],
});

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson(validDigestJson).title).toBe("Auth work");
  });
  it("parses JSON wrapped in fences and prose", () => {
    const wrapped = "Here you go:\n```json\n" + validDigestJson + "\n```\nDone!";
    expect(extractJson(wrapped).outcome).toBe("completed");
  });
  it("throws on garbage", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("digestSession", () => {
  const small: CondensedMessage[] = [
    { role: "user", text: "add auth" },
    { role: "assistant", text: "added JWT auth" },
  ];

  it("single chunk: one claude call, validated digest", async () => {
    const prompts: string[] = [];
    const runner = async (p: string) => { prompts.push(p); return validDigestJson; };
    const d = await digestSession(small, runner);
    expect(d.title).toBe("Auth work");
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("add auth");         // transcript included
    expect(prompts[0]).toContain("JSON");             // format instructions included
  });

  it("clamps out-of-range values", async () => {
    const bad = JSON.stringify({ title: "x", summary: "y", decisions: "not-an-array",
      outcome: "weird", topics: ["a","b","c","d","e","f","g","h","i","j"] });
    const d = await digestSession(small, async () => bad);
    expect(d.decisions).toEqual([]);
    expect(d.outcome).toBe("ongoing");                 // invalid outcome → ongoing
    expect(d.topics.length).toBeLessThanOrEqual(8);
  });

  it("long transcript: chunk summaries then rollup", async () => {
    const long: CondensedMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: "user" as const, text: `message ${i} ` + "x".repeat(1900),
    }));
    const calls: string[] = [];
    const runner = async (p: string) => {
      calls.push(p);
      return p.includes("PARTIAL SUMMARY") ? "partial summary text" : validDigestJson;
    };
    const d = await digestSession(long, runner);
    expect(calls.length).toBeGreaterThan(1);           // chunked
    expect(d.title).toBe("Auth work");                 // final rollup digest
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/digester.test.ts`
Expected: FAIL — cannot resolve `../src/digester.js`.

- [ ] **Step 3: Implement src/digester.ts**

```ts
import type { CondensedMessage, Digest } from "./types.js";

export type ClaudeRunner = (prompt: string) => Promise<string>;
export const CHUNK_CHAR_LIMIT = 48_000;

const DIGEST_INSTRUCTIONS = `You are indexing a Claude Code session transcript.
Reply with ONLY a JSON object, no other text:
{
  "title": "short 5-10 word title of what this session was about",
  "summary": "3-6 sentences: what was worked on, what happened, current state",
  "decisions": ["each notable decision made, with its reason, as one string"],
  "outcome": "completed" | "ongoing" | "abandoned",
  "topics": ["3-8 short lowercase tags like auth, deploy, sqlite"]
}`;

export function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(text.slice(start, end + 1));
}

function validate(raw: any): Digest {
  const outcomes = new Set(["completed", "ongoing", "abandoned"]);
  return {
    title: String(raw.title ?? "Untitled session").slice(0, 120),
    summary: String(raw.summary ?? "").slice(0, 2000),
    decisions: Array.isArray(raw.decisions) ? raw.decisions.map(String).slice(0, 12) : [],
    outcome: outcomes.has(raw.outcome) ? raw.outcome : "ongoing",
    topics: Array.isArray(raw.topics)
      ? raw.topics.map((t: any) => String(t).toLowerCase()).slice(0, 8) : [],
  };
}

function renderTranscript(msgs: CondensedMessage[]): string {
  return msgs.map(m => `${m.role.toUpperCase()}: ${m.text}`).join("\n\n");
}

function chunk(msgs: CondensedMessage[]): CondensedMessage[][] {
  const chunks: CondensedMessage[][] = [];
  let current: CondensedMessage[] = [];
  let size = 0;
  for (const m of msgs) {
    if (size + m.text.length > CHUNK_CHAR_LIMIT && current.length > 0) {
      chunks.push(current); current = []; size = 0;
    }
    current.push(m); size += m.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function digestSession(
  condensed: CondensedMessage[], run: ClaudeRunner,
): Promise<Digest> {
  const chunks = chunk(condensed);
  if (chunks.length === 1) {
    const reply = await run(`${DIGEST_INSTRUCTIONS}\n\nTRANSCRIPT:\n${renderTranscript(chunks[0])}`);
    return validate(extractJson(reply));
  }
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const reply = await run(
      `PARTIAL SUMMARY task: summarize this portion (${i + 1}/${chunks.length}) of a coding
session in 5-8 sentences of plain text. Include work done, decisions, and state.\n\n` +
      renderTranscript(chunks[i]));
    partials.push(reply.trim());
  }
  const reply = await run(
    `${DIGEST_INSTRUCTIONS}\n\nTRANSCRIPT (as sequential partial summaries):\n` +
    partials.map((p, i) => `PART ${i + 1}:\n${p}`).join("\n\n"));
  return validate(extractJson(reply));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/digester.test.ts`
Expected: PASS (6 tests).

---

### Task 7: Claude runner, indexer orchestration, CLI

**Files:**
- Create: `src/claude-runner.ts`, `src/indexer.ts`, `src/cli.ts`
- Test: `tests/indexer.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `makeClaudeRunner(opts?: { model?: string; timeoutMs?: number }): ClaudeRunner` — spawns `claude -p --output-format json --model <model>`, prompt via stdin, cwd = `digesterCwd()`; parses stdout JSON and returns its `result` field.
  - `indexSessionFile(filePath: string, store: SessionStore, run: ClaudeRunner | null): Promise<"indexed" | "skipped-unchanged" | "skipped-active">` — parse + upsert always; digest only when `run` given and digest pending.
  - `scanSessionFiles(): string[]` — all session jsonl paths across projects, excluding `excludedProjectDirs()`.
  - `backfill(store, run, onProgress?: (done: number, total: number) => void): Promise<void>`
  - CLI commands: `index [--session <path>] [--no-digest]`, `backfill [--no-digest]`, `search <query...> [--project <p>] [--limit <n>]`, `digest-pending`.

- [ ] **Step 1: Write failing tests (indexer with fake runner, real temp files)**

`tests/indexer.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { indexSessionFile } from "../src/indexer.js";
import { SessionStore } from "../src/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const validDigestJson = JSON.stringify({
  title: "T", summary: "S", decisions: [], outcome: "completed", topics: ["x"],
});

function tempCopyOfFixture(name: string, ageMinutes: number): string {
  const src = path.join(__dirname, "fixtures", name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-test-"));
  const dst = path.join(dir, "aaa-111.jsonl");
  fs.copyFileSync(src, dst);
  const t = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(dst, t, t);
  return dst;
}

describe("indexSessionFile", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(":memory:"); });

  it("indexes and digests an inactive session", async () => {
    const file = tempCopyOfFixture("basic-session.jsonl", 30);
    const result = await indexSessionFile(file, store, async () => validDigestJson);
    expect(result).toBe("indexed");
    const row = store.getSession("aaa-111")!;
    expect(row.digestStatus).toBe("done");
    expect(row.digestTitle).toBe("T");
  });

  it("skips a file modified under 2 minutes ago", async () => {
    const file = tempCopyOfFixture("basic-session.jsonl", 0);
    const result = await indexSessionFile(file, store, async () => validDigestJson);
    expect(result).toBe("skipped-active");
  });

  it("skips unchanged files on re-run", async () => {
    const file = tempCopyOfFixture("basic-session.jsonl", 30);
    await indexSessionFile(file, store, async () => validDigestJson);
    const second = await indexSessionFile(file, store, async () => validDigestJson);
    expect(second).toBe("skipped-unchanged");
  });

  it("stores metadata even when the digest run fails", async () => {
    const file = tempCopyOfFixture("basic-session.jsonl", 30);
    const result = await indexSessionFile(file, store, async () => { throw new Error("boom"); });
    expect(result).toBe("indexed");
    const row = store.getSession("aaa-111")!;
    expect(row.digestStatus).toBe("failed");
    expect(row.projectPath).toBe("D:\\Projects\\demo"); // metadata survived
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/indexer.test.ts`
Expected: FAIL — cannot resolve `../src/indexer.js`.

- [ ] **Step 3: Implement src/claude-runner.ts**

```ts
import { spawn } from "node:child_process";
import { digesterCwd } from "./paths.js";
import type { ClaudeRunner } from "./digester.js";

export function makeClaudeRunner(
  opts: { model?: string; timeoutMs?: number } = {},
): ClaudeRunner {
  const model = opts.model ?? "claude-haiku-4-5";
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return (prompt: string) =>
    new Promise((resolve, reject) => {
      // shell:true so Windows resolves the `claude` .cmd shim
      const child = spawn("claude", ["-p", "--output-format", "json", "--model", model],
        { cwd: digesterCwd(), shell: true, windowsHide: true });
      let out = "", err = "";
      const timer = setTimeout(() => {
        child.kill(); reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${err.slice(0, 500)}`));
        try {
          const parsed = JSON.parse(out);
          if (typeof parsed.result !== "string") throw new Error("no result field");
          resolve(parsed.result);
        } catch (e) { reject(new Error(`unparseable claude output: ${String(e)}`)); }
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
}
```

- [ ] **Step 4: Implement src/indexer.ts**

```ts
import fs from "node:fs";
import path from "node:path";
import { parseSessionFile } from "./parser.js";
import { claudeProjectsDir, excludedProjectDirs } from "./paths.js";
import type { SessionStore } from "./store.js";
import { digestSession, type ClaudeRunner } from "./digester.js";

const ACTIVE_WINDOW_MS = 2 * 60_000;

export function scanSessionFiles(): string[] {
  const root = claudeProjectsDir();
  if (!fs.existsSync(root)) return [];
  const excluded = excludedProjectDirs();
  const out: string[] = [];
  for (const dir of fs.readdirSync(root)) {
    if (excluded.has(dir)) continue;
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith(".jsonl")) out.push(path.join(full, f));
    }
  }
  return out;
}

export async function indexSessionFile(
  filePath: string, store: SessionStore, run: ClaudeRunner | null,
): Promise<"indexed" | "skipped-unchanged" | "skipped-active"> {
  const stat = fs.statSync(filePath);
  if (Date.now() - stat.mtimeMs < ACTIVE_WINDOW_MS) return "skipped-active";
  if (store.isUnchanged(filePath, stat.mtimeMs, stat.size)) {
    // digest may still be pending from an earlier failed run
    const existing = store.getSession(path.basename(filePath, ".jsonl"));
    if (!run || existing?.digestStatus === "done") return "skipped-unchanged";
  }
  const { meta, condensed } = parseSessionFile(filePath);
  store.upsertSession(meta);
  if (run && condensed.length > 0) {
    try {
      const digest = await digestSession(condensed, run);
      store.setDigest(meta.sessionId, digest);
    } catch (e) {
      console.error(`digest failed for ${meta.sessionId}: ${String(e)}`);
      store.markDigestFailed(meta.sessionId);
    }
  }
  return "indexed";
}

export async function backfill(
  store: SessionStore, run: ClaudeRunner | null,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const files = scanSessionFiles();
  let done = 0;
  for (const f of files) {
    try { await indexSessionFile(f, store, run); }
    catch (e) { console.error(`failed to index ${f}: ${String(e)}`); }
    onProgress?.(++done, files.length);
  }
}
```

- [ ] **Step 5: Implement src/cli.ts**

```ts
import { Command } from "commander";
import { SessionStore } from "./store.js";
import { dbPath } from "./paths.js";
import { makeClaudeRunner } from "./claude-runner.js";
import { indexSessionFile, backfill, scanSessionFiles } from "./indexer.js";

const program = new Command();
program.name("sessiontrack").description("Claude Code session knowledge base");

program.command("index")
  .description("Index one session file (or all changed sessions)")
  .option("--session <path>", "path to a specific session .jsonl")
  .option("--no-digest", "skip LLM digest, metadata only")
  .action(async (opts) => {
    const store = new SessionStore(dbPath());
    const run = opts.digest ? makeClaudeRunner() : null;
    if (opts.session) {
      console.log(await indexSessionFile(opts.session, store, run));
    } else {
      await backfill(store, run, (d, t) => process.stdout.write(`\r${d}/${t}`));
      console.log();
    }
    store.close();
  });

program.command("backfill")
  .description("Index every session on this machine")
  .option("--no-digest", "skip LLM digests, metadata only")
  .action(async (opts) => {
    const files = scanSessionFiles();
    console.log(`${files.length} session files found.`);
    if (opts.digest) console.log(`Digesting with claude -p (haiku); this is slow — expect a few seconds per session.`);
    const store = new SessionStore(dbPath());
    const run = opts.digest ? makeClaudeRunner() : null;
    await backfill(store, run, (d, t) => process.stdout.write(`\r${d}/${t} indexed`));
    console.log("\ndone");
    store.close();
  });

program.command("search <query...>")
  .description("Search session digests")
  .option("--project <path>", "filter to one project path")
  .option("--limit <n>", "max results", "10")
  .action((query: string[], opts) => {
    const store = new SessionStore(dbPath());
    const hits = store.searchSessions(query.join(" "),
      { project: opts.project, limit: parseInt(opts.limit, 10) });
    for (const h of hits) {
      console.log(`\n[${h.sessionId}] ${h.title ?? "(no digest)"} — ${h.projectPath}`);
      console.log(`  ${h.startedAt ?? "?"}  outcome: ${h.outcome ?? "?"}`);
      console.log(`  ${h.snippet}`);
    }
    if (hits.length === 0) console.log("no matches");
    store.close();
  });

program.command("digest-pending")
  .description("Retry digests for sessions marked pending/failed")
  .action(async () => {
    const store = new SessionStore(dbPath());
    const run = makeClaudeRunner();
    const pending = store.sessionsNeedingDigest();
    console.log(`${pending.length} sessions need digests`);
    for (const row of pending) {
      await indexSessionFile(row.filePath, store, run).catch(e => console.error(String(e)));
    }
    store.close();
  });

program.parseAsync();
```

- [ ] **Step 6: Run tests, then a real end-to-end smoke (no digest)**

Run: `npx vitest run tests/indexer.test.ts` — expected: PASS (4 tests).
Run: `npx tsx src/cli.ts backfill --no-digest` — expected: prints found-count and progress over the real `~/.claude/projects`, exits cleanly.
Run: `npx tsx src/cli.ts search sessiontrack` — expected: no crash ("no matches" is fine — digests don't exist yet; FTS rows are only created by setDigest).

- [ ] **Step 7: Real digest smoke on ONE session**

Pick any small real session file and run:
`npx tsx src/cli.ts index --session "C:\Users\tejas\.claude\projects\<some-dir>\<some-id>.jsonl"`
Expected: prints `indexed`; then `npx tsx src/cli.ts search <a word from that session>` returns it. This is the first live `claude -p` call — if it fails, inspect stderr in the error message (login state, model name).

---

### Task 8: MCP server

**Files:**
- Create: `src/mcp.ts`, `src/excerpt.ts`
- Modify: `src/cli.ts` (add `mcp` command)
- Test: `tests/excerpt.test.ts`, `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `parseSessionFile`.
- Produces:
  - `getSessionExcerpt(filePath: string, query: string, maxSnippets?: number): string[]` in `src/excerpt.ts` — term-overlap scored raw-message snippets (each ≤ 700 chars).
  - `buildMcpServer(store: SessionStore): McpServer` in `src/mcp.ts` with tools `search_sessions`, `get_session_digest`, `get_session_excerpt`, `related_sessions`, `list_projects`.
  - CLI: `sessiontrack mcp` runs the server on stdio.

- [ ] **Step 1: Write failing excerpt test**

`tests/excerpt.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { getSessionExcerpt } from "../src/excerpt.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = path.join(__dirname, "fixtures", "basic-session.jsonl");

describe("getSessionExcerpt", () => {
  it("returns messages matching the query, best first", () => {
    const snippets = getSessionExcerpt(fx, "SQL unescaped");
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0]).toContain("SQL string was unescaped");
  });
  it("returns empty array when nothing matches", () => {
    expect(getSessionExcerpt(fx, "kubernetes helm chart")).toEqual([]);
  });
  it("caps snippet length", () => {
    for (const s of getSessionExcerpt(fx, "login")) expect(s.length).toBeLessThanOrEqual(700);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/excerpt.test.ts`
Expected: FAIL — cannot resolve `../src/excerpt.js`.

- [ ] **Step 3: Implement src/excerpt.ts**

```ts
import { parseSessionFile } from "./parser.js";

export function getSessionExcerpt(
  filePath: string, query: string, maxSnippets = 5,
): string[] {
  const { condensed } = parseSessionFile(filePath);
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
  if (terms.length === 0) return [];
  const scored = condensed
    .map(m => {
      const lower = m.text.toLowerCase();
      const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
      return { text: `${m.role}: ${m.text}`.slice(0, 700), score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, maxSnippets).map(s => s.text);
}
```

Run: `npx vitest run tests/excerpt.test.ts` — expected: PASS (3 tests).

- [ ] **Step 4: Implement src/mcp.ts**

```ts
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
      project: z.string().optional().describe("exact project path filter, e.g. D:\\Projects\\demo"),
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
```

- [ ] **Step 5: Wire `mcp` command into src/cli.ts**

Add to `src/cli.ts`:
```ts
program.command("mcp")
  .description("Run the sessiontrack MCP server on stdio")
  .action(async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { buildMcpServer } = await import("./mcp.js");
    const store = new SessionStore(dbPath());
    const server = buildMcpServer(store);
    await server.connect(new StdioServerTransport());
  });
```

- [ ] **Step 6: Write MCP integration test (in-memory transport)**

`tests/mcp.test.ts`:
```ts
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
```

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: PASS across the board. If SDK import paths error, check installed SDK version's export map (`node_modules/@modelcontextprotocol/sdk/package.json`) and adjust the subpath imports to match.

- [ ] **Step 8: Register with Claude Code and live-verify**

Run: `npm run build` (must succeed — this is what the registration uses)
Run: `claude mcp add sessiontrack -s user -- node "D:\Projects\sessiontrack\dist\cli.js" mcp`
Then in a NEW terminal: `claude mcp list` — expected: sessiontrack listed and connects. Ask the user to try `search_sessions` from any Claude Code session when convenient.

---

### Task 9: SessionEnd hook

**Files:**
- Create: `src/hook.ts`
- Modify: `src/cli.ts` (add `install-hook`, `hook-run` commands)
- Test: `tests/hook.test.ts`

**Interfaces:**
- Consumes: `indexSessionFile`, `SessionStore`, `makeClaudeRunner`.
- Produces:
  - `installHook(settingsPath: string, cliJsAbsPath: string): { installed: boolean; already: boolean }` — idempotently adds a SessionEnd hook entry to Claude settings JSON.
  - CLI `hook-run` — reads the hook JSON payload from stdin (`{ transcript_path: ... }`), indexes that one file with digest, always exits 0 (a broken indexer must never make Claude Code sessions hang or error).
  - CLI `install-hook` — calls `installHook` on `~/.claude/settings.json` with the built `dist/cli.js` path.

- [ ] **Step 1: Write failing tests**

`tests/hook.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { installHook } from "../src/hook.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tempSettings(content: object | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-hook-"));
  const p = path.join(dir, "settings.json");
  if (content !== null) fs.writeFileSync(p, JSON.stringify(content, null, 2));
  return p;
}

describe("installHook", () => {
  it("adds a SessionEnd hook to empty settings", () => {
    const p = tempSettings({});
    const r = installHook(p, "D:\\Projects\\sessiontrack\\dist\\cli.js");
    expect(r.installed).toBe(true);
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    const cmd = s.hooks.SessionEnd[0].hooks[0].command;
    expect(cmd).toContain("hook-run");
    expect(s.hooks.SessionEnd[0].hooks[0].timeout).toBe(600);
  });

  it("creates settings file when missing", () => {
    const p = tempSettings(null);
    const r = installHook(p, "C:\\x\\cli.js");
    expect(r.installed).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("is idempotent", () => {
    const p = tempSettings({});
    installHook(p, "C:\\x\\cli.js");
    const r2 = installHook(p, "C:\\x\\cli.js");
    expect(r2.already).toBe(true);
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(s.hooks.SessionEnd.length).toBe(1);
  });

  it("preserves existing unrelated hooks", () => {
    const p = tempSettings({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo hi" }] }] } });
    installHook(p, "C:\\x\\cli.js");
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(s.hooks.SessionEnd.length).toBe(2);
    expect(s.hooks.SessionEnd[0].hooks[0].command).toBe("echo hi");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/hook.test.ts`
Expected: FAIL — cannot resolve `../src/hook.js`.

- [ ] **Step 3: Implement src/hook.ts**

```ts
import fs from "node:fs";

const MARKER = "sessiontrack";

export function installHook(
  settingsPath: string, cliJsAbsPath: string,
): { installed: boolean; already: boolean } {
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  }
  settings.hooks ??= {};
  settings.hooks.SessionEnd ??= [];
  const exists = settings.hooks.SessionEnd.some((entry: any) =>
    entry?.hooks?.some((h: any) => typeof h.command === "string" && h.command.includes(MARKER)));
  if (exists) return { installed: false, already: true };
  settings.hooks.SessionEnd.push({
    hooks: [{
      type: "command",
      command: `node "${cliJsAbsPath}" hook-run`,
      timeout: 600,
    }],
  });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, already: false };
}
```

- [ ] **Step 4: Add CLI commands to src/cli.ts**

```ts
program.command("hook-run")
  .description("SessionEnd hook entry: reads hook JSON from stdin, indexes that session")
  .action(async () => {
    try {
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const payload = JSON.parse(input);
      const transcript = payload.transcript_path;
      if (typeof transcript === "string" && transcript.endsWith(".jsonl")) {
        const store = new SessionStore(dbPath());
        // ACTIVE_WINDOW check would always skip a just-ended session; bypass by
        // indexing directly when invoked from the hook:
        const { parseSessionFile } = await import("./parser.js");
        const { digestSession } = await import("./digester.js");
        const { meta, condensed } = parseSessionFile(transcript);
        store.upsertSession(meta);
        try {
          if (condensed.length > 0) store.setDigest(meta.sessionId, await digestSession(condensed, makeClaudeRunner()));
        } catch (e) { store.markDigestFailed(meta.sessionId); }
        store.close();
      }
    } catch (e) {
      console.error(String(e)); // never non-zero: a broken hook must not break Claude
    }
    process.exit(0);
  });

program.command("install-hook")
  .description("Install the SessionEnd auto-index hook into ~/.claude/settings.json")
  .action(async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const { installHook } = await import("./hook.js");
    const settings = path.join(os.homedir(), ".claude", "settings.json");
    const cliJs = path.resolve("dist", "cli.js");
    const r = installHook(settings, cliJs);
    console.log(r.already ? "hook already installed" : `hook installed → ${settings}`);
    console.log("Run 'npm run build' after code changes; the hook runs dist/cli.js.");
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/hook.test.ts` — expected: PASS (4 tests).
Run: `npm test` — expected: full suite PASS.

- [ ] **Step 6: Install the hook for real and verify**

Run: `npm run build`, then `npx tsx src/cli.ts install-hook`.
Verify: open `~/.claude/settings.json`, confirm the SessionEnd entry exists and nothing else was touched. Tell the user the hook will index each session as it ends from now on.

---

### Task 10: Full backfill + LEARNING.md + wrap-up

**Files:**
- Create: `docs/LEARNING.md`, `README.md`

**Interfaces:** none — this task operationalizes and documents.

- [ ] **Step 1: Metadata-only backfill of the whole machine**

Run: `npx tsx src/cli.ts backfill --no-digest`
Expected: completes over all projects; note the total count.

- [ ] **Step 2: Digest backfill (long-running)**

Run: `npx tsx src/cli.ts backfill` in the background (Bash tool `run_in_background: true`; each session ≈ seconds to a minute via claude -p). Report progress to the user; it is resumable — re-running skips digested sessions.

- [ ] **Step 3: Verify search quality end-to-end**

Run: `npx tsx src/cli.ts search <term the user actually worked on, e.g. caddy>`
Expected: relevant sessions with readable snippets. Try 3–4 queries; note any misses for the "embeddings later?" decision in the spec.

- [ ] **Step 4: Write docs/LEARNING.md**

Write the first three chapters, grounded in THIS codebase (not generic tutorials), ~150–250 words each with pointers into the code:
1. **Anatomy of a Claude Code session file** — JSONL, line types seen in real data (user/assistant/ai-title/file-history-snapshot/...), which fields matter (`cwd`, `timestamp`, `message.model`, tool_use blocks), and why parsing must tolerate unknown types (`src/parser.ts`).
2. **How our SQLite index works** — one DB, WAL mode, why FTS5 + bm25 gives ranked search without a search server, how `setDigest` keeps the FTS table in sync (`src/db.ts`, `src/store.ts`).
3. **What MCP actually is** — JSON-RPC over stdio, tools = typed functions advertised to the model, how `claude mcp add` wires our process into every session (`src/mcp.ts`).
Chapters on hooks, graph modeling, and Neo4j/Cypher are added by the later plans.

- [ ] **Step 5: Write README.md**

Short: what sessiontrack is, the commands (`backfill`, `index`, `search`, `digest-pending`, `mcp`, `install-hook`), where data lives (`~/.sessiontrack/index.db`), how the hook works, pointer to `docs/LEARNING.md` and the spec. No badges, no fluff.

- [ ] **Step 6: Final verification**

Run: `npm test` (all pass), `npx tsc --noEmit` (clean), `claude mcp list` (sessiontrack connected). Report to the user: session count indexed, digest coverage %, example searches that worked, and the reminder that NOTHING is committed to git yet by their instruction.

---

## Self-Review (completed)

- **Spec coverage:** Parser §4.1 → Task 3; Digester §4.2 → Tasks 6–7; Store §4.3 → Tasks 4–5; MCP §4.4 → Task 8; Triggers §4.5 → Tasks 7 (backfill) and 9 (hook); edge cases §6 → active-session skip (T7), malformed lines (T3), digest failure → pending/failed (T7), WAL/busy timeout (T4), chunking (T6). Web UI §4.6 and Neo4j §4.7 are deliberately separate future plans. `source_missing` column exists (T4 schema) but no reaper job — acceptable for v1, excerpt tool handles missing files gracefully (T8).
- **Placeholder scan:** no TBDs; every code step has concrete code.
- **Type consistency:** `SessionRow` fields checked across store/search/MCP tasks; `ClaudeRunner` signature identical in Tasks 6, 7, 9; fixture session ids consistent (`aaa-111`, `bbb-222`).
- **Continuation links:** `session_continues` table exists but v1 has no reliable extraction signal (spec notes this); `relatedSessions` degrades gracefully to files/topics. Recorded as a known gap, not a placeholder.
