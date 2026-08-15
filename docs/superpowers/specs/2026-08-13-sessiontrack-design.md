# sessiontrack — Design Spec

**Date:** 2026-08-13
**Status:** Approved design, pre-implementation
**Platform:** Windows-first (user's machine), but nothing OS-specific by design

## 1. Problem

Claude Code stores every session as a JSONL transcript under
`~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`, but that
history is effectively dead weight: when a session is lost or a new one
starts, re-establishing context means re-explaining everything or
re-reading enormous transcripts — both very token-expensive.

**Goal:** make the entire machine-wide session history a cheap, queryable
knowledge layer that any live Claude session can use, plus a visual,
human-friendly way to explore it.

Secondary goal: the project doubles as a learning vehicle — the user wants
to understand each piece as it is built (session file anatomy, FTS5, MCP
protocol, graph modeling, Neo4j/Cypher). See §10.

## 2. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Access mechanism for Claude | **MCP server** (stdio) | Structured tools, available to every Claude Code session and Claude Desktop automatically |
| Result shape | **LLM-distilled digests** with raw-excerpt drill-down | Returning raw transcripts would recreate the token problem being solved |
| Digest engine | **`claude -p` headless (Haiku)** | Uses existing Claude Code subscription; no separate API billing |
| Index trigger | **SessionEnd hook + one-time backfill** | Zero-effort freshness; backfill covers history |
| Storage/search | **SQLite + FTS5** (better-sqlite3) | Single file, zero services, strong ranked full-text search |
| Language | **TypeScript / Node** | First-class MCP SDK; Node already on machine via Claude Code |
| Embeddings | **Not in v1** | FTS5 over well-written digests first; add semantic search only if recall provably falls short |
| Human UI | **Local web app** served by CLI (`sessiontrack ui`) | Live data, room for browse/search/graph; Electron explicitly rejected (heavyweight for zero benefit); static-HTML-only rejected (frozen data, graph-only) |
| Graph exploration | **Layered:** built-in web graph + optional Neo4j export | Neo4j is a learning playground, never load-bearing; core works with Docker off |

## 3. Architecture

```
~/.claude/projects/**/*.jsonl
        │
        ▼
  [Scanner/Parser]  ── mechanical extraction, no LLM
        │
        ▼
  [Digester]        ── claude -p (Haiku), structured digest
        │
        ▼
  ┌─────────────── SQLite (single source of truth) ───────────────┐
  │  sessions · projects · files · topics · edges · FTS5 index    │
  └───────┬───────────────┬────────────────┬─────────────┬────────┘
          ▼               ▼                ▼             ▼
     MCP server        CLI            Web UI         Neo4j export
     (for Claude)    (for user)    (localhost)      (optional)
```

Every consumer reads from SQLite; no consumer depends on another. Any
layer can be off or broken without affecting the rest.

## 4. Components

### 4.1 Scanner/Parser (mechanical, free, instant)
- Walks `~/.claude/projects` (configurable additional roots later).
- Parses each session JSONL line-by-line; tolerates unknown/malformed
  lines (log and skip, never crash).
- Extracts: project path (decoded), session id, start/end timestamps,
  first user prompt, files edited (from tool-call records), git branch
  (when discoverable from transcript), models used, message count,
  continuation link (resumed/compacted-from session id when present).

### 4.2 Digester (LLM, per-session, incremental)
- For each parsed-but-undigested session, invokes `claude -p` with a
  Haiku model and a structured prompt over the transcript.
- Output digest fields:
  ```
  { title, summary (3–6 sentences), decisions[],
    outcome: completed | ongoing | abandoned,
    topics[] (3–8 tags) }
  ```
- Long transcripts: chunk → summarize chunks → roll up.
- On `claude -p` failure: mark session `pending`, retry next run.

### 4.3 Store (SQLite via better-sqlite3)
- Tables: `sessions`, `projects`, `files`, `topics`;
  link tables: `session_files`, `session_topics`,
  `session_continues (from_id, to_id)`.
- FTS5 virtual table over: digest title + summary + decisions + first
  prompt + topics. Ranked search via bm25.
- Re-index policy: a session is re-processed only when its file's
  mtime/size changed since last index. The currently-active session
  (file still growing / most recent activity) is skipped.

### 4.4 MCP server (stdio, official TypeScript SDK)
Tools:
| Tool | Returns |
|---|---|
| `search_sessions(query, project?, limit?)` | Ranked digest snippets (~200 tokens each) |
| `get_session_digest(session_id)` | Full digest record |
| `get_session_excerpt(session_id, query)` | Targeted raw-transcript excerpts — the only path to raw text |
| `related_sessions(session_id)` | Graph neighbors: same files, shared topics, continuation chain |
| `list_projects()` | Projects with session counts and last activity |

### 4.5 Indexing triggers
- **SessionEnd hook** in Claude settings runs `sessiontrack index` for the
  just-ended session (setup assisted by `sessiontrack install-hook`).
- **`sessiontrack backfill`**: one-time historical indexing. Shows
  count + rough time estimate up front, shows progress, is resumable
  (already-indexed sessions skipped via mtime/size check).

### 4.6 Web UI (`sessiontrack ui`)
- CLI starts a small local HTTP server (localhost, random or configured
  port) serving a lightweight frontend + a few JSON endpoints over the
  SQLite data. No auth (localhost only). Dies with the process; nothing
  installed.
- Pages:
  - **Sessions** — browse + search-as-you-type (FTS5-backed), read digests,
    filter by project/outcome/date.
  - **Graph** — interactive force-directed graph (vis-network or
    Cytoscape.js): nodes = sessions/projects/files/topics; filters;
    click node → digest panel.
  - **Projects** — per-project dashboard: session count, activity,
    top topics/files.
- Frontend kept deliberately simple; exact framework (Vite+React vs
  vanilla) decided at implementation.
- Electron: explicitly out of scope, permanently.

### 4.7 Neo4j export (optional, learning-oriented)
- `sessiontrack export neo4j` pushes the graph over Bolt into a local
  Neo4j container; repo includes a ready `docker-compose.yml`.
- Graph model: `(Session)-[:IN_PROJECT]->(Project)`,
  `(Session)-[:TOUCHED]->(File)`, `(Session)-[:ABOUT]->(Topic)`,
  `(Session)-[:CONTINUES]->(Session)`.
- Strictly one-directional export; Neo4j is never read by other
  components. Container off ⇒ everything else unaffected.

## 5. Data flow summary

1. Session ends → hook fires → parse → digest → upsert into SQLite.
2. Claude (any project) → MCP `search_sessions` → digest snippets →
   optional `get_session_excerpt` drill-down.
3. User → `sessiontrack ui` → browse/search/graph on live data.
4. User (optionally) → `sessiontrack export neo4j` → Cypher exploration.

## 6. Edge cases & error handling

- Active session file still growing → skipped until inactive.
- Malformed / unknown JSONL line types → logged, skipped, never fatal.
- `claude -p` failure or timeout → digest status `pending`, retried on
  next indexing run; mechanical metadata still stored and searchable.
- Very long transcripts → chunked digest roll-up (§4.2).
- Deleted session files → rows retained, marked `source_missing`.
- Concurrent indexing runs → SQLite WAL mode + busy timeout; hook
  invocations are short-lived and idempotent.

## 7. Testing

TDD throughout (superpowers test-driven-development):
- **Parser:** fixture JSONL files, including real-world weird lines and
  truncated/corrupt cases.
- **Store/search:** in-memory SQLite; FTS ranking sanity checks.
- **Digester:** `claude` invocation mocked; chunking logic unit-tested.
- **MCP tools:** integration tests against a seeded test DB.
- **Web endpoints:** integration tests against the same seeded DB.

## 8. Build phases

Each phase lands working end-to-end before the next starts:
1. Parser (fixtures → extracted metadata)
2. Store + FTS search (CLI `search` works mechanically)
3. Digester (`claude -p` integration; backfill command)
4. MCP server (Claude can query it)
5. SessionEnd hook (auto-freshness)
6. Web UI (sessions → graph → projects pages)
7. Neo4j export + docker-compose + Cypher cheat-sheet

## 9. Out of scope (v1)

- Embeddings / semantic search (revisit only if FTS5 recall disappoints)
- Electron or any packaged desktop app
- Multi-machine sync / remote access
- Indexing non-Claude-Code data sources
- Editing/annotating sessions from the UI (read-only v1)

## 10. Learning layer

`docs/LEARNING.md` grows with each phase, written for the user:
session JSONL anatomy, how FTS5/bm25 ranking works, what MCP looks like
on the wire, graph modeling choices, Neo4j setup and a Cypher
cheat-sheet with real queries over the user's own data. In-chat
explanations accompany each build phase.
