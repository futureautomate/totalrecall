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

---

Chapters on the SessionEnd hook mechanics, graph modeling over the
session/file/topic data, and Neo4j/Cypher exploration arrive with later
build phases.
