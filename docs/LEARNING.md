# totalrecall — Learning Notes

These notes exist to teach the concepts this project is built on, grounded
in the actual code — not generic tutorials. Each chapter lands with the
build phase that needed it.

## 1. Anatomy of a Claude Code session file

Claude Code writes every session as JSONL (one JSON object per line) to
`~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`. The
directory name is the project's real path with every character outside
`[A-Za-z0-9-]` replaced by `-` (see `encodeProjectPath`,
`src/paths.ts:27`) — `D:\Projects\totalrecall` becomes something like
`D--Projects-totalrecall`.

Lines come in many types — on this machine we've seen `user`, `assistant`,
`attachment`, `file-history-snapshot`, `system`, `last-prompt`,
`permission-mode`, `mode`, `ai-title`, `file-history-delta`, and
`queue-operation`. `parseSessionFile` (`src/parser.ts:21`) reads every line
but only extracts message content from `user`/`assistant` types
(`src/parser.ts:53`); everything else is either mined for a specific field
(e.g. `ai-title` lines carry the session's display title, `src/parser.ts:51`)
or ignored. Malformed JSON is caught and skipped per line
(`src/parser.ts:46`) — the parser must never crash on one bad line in an
otherwise-good file.

The fields that matter: `cwd` (first seen becomes the project path),
`timestamp` (first/last become `startedAt`/`endedAt`), `message.model` on
assistant lines (which models were used), and `message.content` — either a
plain string or an array of typed blocks, where `tool_use` blocks with
names like `Edit`/`Write` and an `input.file_path` tell us which files were
touched (`EDIT_TOOLS`, `src/parser.ts:5`). Tolerating unknown line types
isn't defensive-programming boilerplate — Claude Code's transcript format
has grown new line types over time, and it will keep doing so.

## 2. How our SQLite index works

Everything lives in one file, `~/.totalrecall/index.db` (`dbPath`,
`src/paths.ts:15`), opened in WAL mode with a 5-second busy timeout
(`src/db.ts:5-6`). WAL mode matters because the SessionEnd hook writes to
this file from a short-lived process while a `search` or an MCP query
might be reading it concurrently — WAL lets readers and a writer proceed
without blocking each other.

The schema (`src/db.ts:8-46`) is a `sessions` table holding one row per
session (metadata + digest fields), two link tables (`session_files`,
`session_topics`), a `session_continues` table for resumption chains, and
a `session_fts` **virtual table** built with FTS5. FTS5 is SQLite's
full-text search extension: it tokenizes text columns and lets you rank
matches with `bm25()` — a relevance function that scores based on term
frequency, without running a separate search server like Elasticsearch.
`searchSessions` (`src/store.ts:116`) matches against `session_fts` and
orders by `bm25(session_fts)` ascending (lower/more-negative = more
relevant).

FTS5 tables aren't kept in sync automatically here (no content-table
triggers are set up) — so `setDigest` (`src/store.ts:76`) does it by hand,
in one transaction: update the `sessions` row, replace `session_topics`,
then delete and re-insert the matching `session_fts` row from the fresh
digest text. Delete-then-insert is simpler than an `UPDATE` because FTS5
indexes are built from full-row content, not diffable per-column.

## 3. What MCP actually is

MCP (Model Context Protocol) is JSON-RPC 2.0 running over a transport —
here, stdio: the model's host process spawns our server as a child
process and exchanges JSON-RPC messages over its stdin/stdout
(`StdioServerTransport`, wired up in `src/cli.ts:73`). There's no network
port, no auth — the process boundary is the security boundary.

A "tool" is just a typed function the server advertises to the model:
a name, a description, and an input schema. We build ours with the
official SDK's `McpServer` and `registerTool`, describing inputs with zod
schemas that the SDK turns into JSON Schema for the wire protocol
(`src/mcp.ts:10-53`). totalrecall exposes five: `search_sessions`,
`get_session_digest`, `get_session_excerpt`, `related_sessions`, and
`list_projects`. Every tool handler returns the same shape — a
`content: [{ type: "text", text: ... }]` array, here a JSON string
(`asText`, `src/mcp.ts:6`) — because MCP's tool-result contract is
content blocks, not arbitrary JSON.

`claude mcp add` registers the launch command (`node dist/cli.js mcp`) in
Claude's config once; from then on, every Claude Code session starts this
server automatically and the model sees the five tool schemas as callable
functions, no different in kind from `Read` or `Bash`.

## 4. How the web UI is served

`totalrecall ui` is one Node process, not a frontend server plus a
backend server. `createUiServer` (`src/ui/server.ts`) wraps a single
`http.createServer` that tries three things in order: a hand-rolled
router (`src/ui/router.ts` — a small `segments.length` match, no
dependency, because the route table is five GETs), then static files
under `dist/ui-static`, then an `index.html` fallback so React Router's
client-side routes (`/sessions`, `/graph`, `/projects`) work on a hard
refresh. `/api/*` (`src/ui/api.ts`) is deliberately thin — each handler
is a few lines that parse query params and call straight into
`SessionStore`; the UI has no business logic of its own, so there's
nothing to keep in sync with the CLI's own read paths.

`dist/ui-static` (the Vite bundle) is a separate output directory from
`dist/ui` (the compiled `server.ts`/`router.ts`/`api.ts`) because `tsc`
and `vite build` are two different compilers writing two different kinds
of output into one `dist/` tree; `defaultStaticDir()` walks from the
compiled server's own location (`dist/ui/`) up to `dist/ui-static/` at
runtime rather than hardcoding a path, so the layout survives from source
(`tsx`) and from `dist` (`node`) alike. In dev, `npm run dev:ui` runs
Vite's own server on 5173 with `/api` proxied to a `totalrecall ui`
already running on 4747 (`ui/vite.config.ts`) — two processes only in
development, one in production.

The Graph page's `/api/graph` endpoint returns sessions and topics only,
not files — `graphData` (`src/store.ts:275`) issues one query per graph,
and a session can touch dozens of files, so shipping every file edge
up front would make the initial graph load scale with total edits
touched rather than with sessions viewed. Files are added lazily,
client-side, when you click a session node: `fileElementsFor`
(`ui/src/lib/graphElements.ts`) turns that one session's `filesEdited`
list (already fetched for the digest panel) into Cytoscape nodes/edges
and merges them into the running graph, so the cost of exploring files
is paid per click, not per page load.

---

Chapters on the SessionEnd hook mechanics and Neo4j/Cypher exploration
arrive with later build phases — graph *modeling* over the
session/file/topic data is now partly covered by chapter 4's note on how
the Graph page assembles its Cytoscape elements.
