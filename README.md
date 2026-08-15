# totalrecall

A machine-wide knowledge base over your Claude Code session history.
Claude Code writes every session to a JSONL transcript under
`~/.claude/projects/**`; totalrecall parses those transcripts, has an
LLM (`claude -p`, Haiku) write a short digest of each one, and indexes
the digests in SQLite with full-text search — so any live Claude Code
session, or you from the CLI, can ask "have I done this before?" without
re-reading raw transcripts.

**Using the app day to day: see [docs/GUIDE.md](docs/GUIDE.md)** —
commands with examples, MCP usage from live sessions, maintenance, and
troubleshooting.

See `docs/LEARNING.md` for notes on how the pieces work (session file
anatomy, the SQLite/FTS5 index, what MCP is on the wire), written while
building this.

## How it works, briefly

1. A **parser** (`src/parser.ts`) reads a session's `.jsonl` file
   line-by-line and extracts metadata: project path, timestamps, first
   prompt, models used, files edited, git branch. It tolerates unknown or
   malformed lines — Claude Code's transcript format keeps growing new
   line types.
2. A **digester** (`src/digester.ts`, `src/claude-runner.ts`) sends the
   condensed transcript to `claude -p --model claude-haiku-4-5` and gets
   back a structured digest: title, summary, decisions, outcome, topics.
3. Both are stored in one SQLite file (`src/db.ts`, `src/store.ts`),
   with an FTS5 virtual table for ranked full-text search over digests.
4. An **MCP server** (`src/mcp.ts`) exposes the index to any Claude Code
   session as five tools: `search_sessions`, `get_session_digest`,
   `get_session_excerpt`, `related_sessions`, `list_projects`.
5. A **SessionEnd hook** (`src/hook.ts`, `cli.ts`'s `hook-run` command)
   indexes each session automatically the moment it ends.

## Data location

Everything lives in `~/.totalrecall/index.db` (one SQLite file, WAL
mode). Nothing else is written outside that directory, except the
`digester-cwd` subfolder used as the working directory for `claude -p`
calls (excluded from scanning, so the digester never indexes itself).

## Setup

```
npm install
npm run build      # compiles src/ -> dist/; the hook and bin run dist/cli.js
```

During development you can run commands directly against the source with
`npx tsx src/cli.ts <command>` instead of building first.

## Commands

- **`totalrecall backfill [--no-digest]`** — index every session file on
  the machine (all projects under `~/.claude/projects`). Resumable:
  already-indexed, unchanged files are skipped. `--no-digest` does
  metadata-only indexing (fast, no `claude -p` calls).
- **`totalrecall index [--session <path>] [--no-digest]`** — index one
  specific session file, or (without `--session`) run the same pass as
  `backfill`.
- **`totalrecall search <query...> [--project <path>] [--limit <n>]`** —
  full-text search over digests, ranked by SQLite FTS5's `bm25()`. Prints
  session id, title, project, timestamps, outcome, and a matching
  snippet.
- **`totalrecall digest-pending`** — retry LLM digests for sessions
  whose digest is still `pending` or previously `failed` (e.g. after a
  `claude -p` timeout or crash during backfill).
- **`totalrecall mcp`** — run the MCP server on stdio. This is the
  command `claude mcp add` points at; you normally don't run it by hand.
- **`totalrecall install-hook`** — add a `SessionEnd` hook entry to
  `~/.claude/settings.json` that runs `node dist/cli.js hook-run` after
  every session, so the index stays fresh with zero manual effort.
- **`totalrecall hook-run [marker]`** — the hook's actual entry point:
  reads the hook's JSON payload from stdin, parses and digests the
  session whose transcript just closed. Not meant to be run manually;
  the `marker` argument is only an idempotency check `install-hook` uses
  to detect whether its own entry is already present.
- **`totalrecall ui [--port <n>] [--no-open]`** — start the local web UI
  and open it in your browser (default `http://127.0.0.1:4747`). `--port`
  picks a different port; `--no-open` skips launching a browser.

## Web UI

`totalrecall ui` serves a small read-only app over your indexed sessions,
bound to `127.0.0.1` only — nothing is exposed beyond your machine. Three
pages:

- **Sessions** — search and browse, with filters (project, outcome, date
  range) and a digest panel (summary, decisions, topics, files, related
  sessions). Raw transcript excerpts are fetched on demand, not preloaded.
- **Graph** — sessions clustered around the topics they touch, colored by
  project, with a project-node toggle. Click a session to expand the files
  it edited; click a topic to highlight its neighborhood.
- **Projects** — a table of every indexed project with a digest-coverage
  bar and top topics; clicking a project filters the Sessions page.

The UI needs a build first: `npm run build` compiles the server and
bundles the frontend into `dist/ui-static`.

## How the hook works

`install-hook` writes a `SessionEnd` hook into `~/.claude/settings.json`
that runs `node "<path-to-dist/cli.js>" hook-run totalrecall`. When a
session ends, Claude Code invokes that command and pipes it a JSON
payload on stdin containing (among other fields) `transcript_path`.
`hook-run` parses that transcript, upserts its metadata, and — unlike
the normal indexing path, which skips a file if it was modified in the
last two minutes to avoid indexing a still-growing session — digests it
immediately, since the hook only fires once the session has actually
ended. Any failure inside `hook-run` is caught and logged rather than
thrown, and the process always exits `0`: a broken hook must never break
a Claude Code session.

## Status

Core pipeline (parse → digest → store → search → MCP → hook) is built
and tested (unit + integration tests via `vitest`, see `tests/`). The
local web UI (`totalrecall ui`) is built. An optional Neo4j graph export
is still planned.
