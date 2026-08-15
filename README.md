# sessiontrack

A machine-wide knowledge base over your Claude Code session history.
Claude Code writes every session to a JSONL transcript under
`~/.claude/projects/**`; sessiontrack parses those transcripts, has an
LLM (`claude -p`, Haiku) write a short digest of each one, and indexes
the digests in SQLite with full-text search — so any live Claude Code
session, or you from the CLI, can ask "have I done this before?" without
re-reading raw transcripts.

**Using the app day to day: see [docs/GUIDE.md](docs/GUIDE.md)** —
commands with examples, MCP usage from live sessions, maintenance, and
troubleshooting.

See `docs/superpowers/specs/2026-08-13-sessiontrack-design.md` for the
full design (architecture, decisions, edge cases, build phases) and
`docs/LEARNING.md` for notes on how the pieces work, written while
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

Everything lives in `~/.sessiontrack/index.db` (one SQLite file, WAL
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

- **`sessiontrack backfill [--no-digest]`** — index every session file on
  the machine (all projects under `~/.claude/projects`). Resumable:
  already-indexed, unchanged files are skipped. `--no-digest` does
  metadata-only indexing (fast, no `claude -p` calls).
- **`sessiontrack index [--session <path>] [--no-digest]`** — index one
  specific session file, or (without `--session`) run the same pass as
  `backfill`.
- **`sessiontrack search <query...> [--project <path>] [--limit <n>]`** —
  full-text search over digests, ranked by SQLite FTS5's `bm25()`. Prints
  session id, title, project, timestamps, outcome, and a matching
  snippet.
- **`sessiontrack digest-pending`** — retry LLM digests for sessions
  whose digest is still `pending` or previously `failed` (e.g. after a
  `claude -p` timeout or crash during backfill).
- **`sessiontrack mcp`** — run the MCP server on stdio. This is the
  command `claude mcp add` points at; you normally don't run it by hand.
- **`sessiontrack install-hook`** — add a `SessionEnd` hook entry to
  `~/.claude/settings.json` that runs `node dist/cli.js hook-run` after
  every session, so the index stays fresh with zero manual effort.
- **`sessiontrack hook-run [marker]`** — the hook's actual entry point:
  reads the hook's JSON payload from stdin, parses and digests the
  session whose transcript just closed. Not meant to be run manually;
  the `marker` argument is only an idempotency check `install-hook` uses
  to detect whether its own entry is already present.

## How the hook works

`install-hook` writes a `SessionEnd` hook into `~/.claude/settings.json`
that runs `node "<path-to-dist/cli.js>" hook-run sessiontrack`. When a
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
and tested (unit + integration tests via `vitest`, see `tests/`). A web
UI and an optional Neo4j graph export are designed (see the spec) but
not yet built.
