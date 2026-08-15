# TotalRecall Web UI — Design Spec

**Date:** 2026-08-15
**Status:** Approved design, pre-implementation
**Parent spec:** `2026-08-13-sessiontrack-design.md` §4.6 (this document supersedes that section's detail)

## 1. Purpose

The MCP server is TotalRecall's face for Claude; the web UI is its face for
humans. It lets a person browse, search, and *see* their session history —
including the graph of how sessions relate — without knowing what to ask.
It is also the centerpiece of the public demo, and the first thing a stranger
who installs the package will look at.

**Audience balance (decided):** good on all three fronts — demo-worthy,
usable daily, self-explanatory to newcomers — without chasing perfection on
any one axis.

## 2. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Frontend | **Vite + React + TypeScript** SPA | Component model for three interactive pages; standard stack others can contribute to; builds to static files |
| Serving | **Single Node process**: CLI serves `/api/*` + static bundle | One port, no CORS, no second server; `npm install -g totalrecall && totalrecall ui` just works |
| HTTP layer | Node built-in `http` + tiny router (no Express) | ~8 endpoints don't justify a framework dependency |
| Graph library | **Cytoscape.js** | Mature, handles thousands of nodes, good force layouts, plain-JS API |
| Graph default | **Sessions + topics**, expand files/related on click | Readable at any scale; topics are the most meaningful links; files fan out too much by default |
| Actions | **Read-only + status bar** | Matches parent spec v1; no job management; status tells you which CLI command to run |
| Binding | `127.0.0.1` only, no auth | Localhost tool; remote access is a separate phase (§9) |
| Theme | Dark default, light toggle | Demo-friendly; small design-token stylesheet, no CSS framework |

## 3. Architecture

```
totalrecall ui  ──►  src/ui/server.ts (Node http, port 4747)
                        ├── /api/*  ──► SessionStore (existing) + graphData() (new)
                        └── /*      ──► static dist/ui/ (Vite build, SPA fallback)

ui/ (Vite + React)  ──vite build──►  dist/ui/
```

Dev mode: `vite dev` in `ui/` proxies `/api` to the running Node server for
hot reload. Production: everything is served by the one Node process.

## 4. Server (`src/ui/server.ts`, `src/ui/router.ts`)

CLI: `totalrecall ui [--port <n>] [--no-open]` — default port 4747, opens
the default browser unless `--no-open`, logs the URL, exits on Ctrl-C.
Port already in use → clear error suggesting `--port`.

Endpoints (all `GET`, JSON; every one is a thin call into `SessionStore`):

| Endpoint | Returns |
|---|---|
| `/api/status` | `{ sessions, projects, digested, pending, failed, dbPath }` |
| `/api/projects` | `listProjects()` + per-project digest coverage |
| `/api/sessions?q&project&outcome&from&to&limit&offset` | with `q`: `searchSessions` (ranked, snippets); without: list newest-first with same filters |
| `/api/sessions/:id` | full `SessionRow` (digest, decisions, topics, files, models, dates) |
| `/api/sessions/:id/related` | `relatedSessions(id)` |
| `/api/sessions/:id/excerpt?q` | `getSessionExcerpt(filePath, q)` — the only raw-transcript path |
| `/api/graph?project&from&to` | `{ nodes, edges }` (see §5) |

Errors: unknown session → 404 JSON; bad query → 400 JSON; anything thrown →
500 JSON with message, never a crash of the server process.

## 5. Store additions (`src/store.ts`)

- `listSessions(filters: { project?, outcome?, from?, to?, limit?, offset? })`
  — newest-first browse without a search term (search path already exists).
- `graphData(filters: { project?, from?, to? })` →
  ```
  { nodes: [{ id, type: "session"|"topic"|"project", label, project?, outcome?,
              messageCount?, startedAt? }],
    edges: [{ source, target, kind: "about"|"in_project" }] }
  ```
  Sessions matching the filters, the topics they carry, their projects.
  Files and related-session edges are NOT in the base graph; the client
  fetches `/api/sessions/:id` on click and adds that session's file nodes.
- `projectStats()` — per-project digested/pending/failed counts (for the
  Projects page and status bar).

## 6. Frontend (`ui/`)

Shell: left nav with three pages, footer status bar
(`N sessions · X% digested · Y pending → run "totalrecall digest-pending"`),
theme toggle. Empty state on every page when the DB has zero sessions,
pointing at `totalrecall backfill`.

**Sessions page**
- Search box (debounced 250 ms → `/api/sessions?q=`); filter chips: project,
  outcome, date range. No search term = newest-first browse.
- Result rows: title (or first prompt if undigested), project, date, outcome
  badge, snippet with match highlighting.
- Click → right-side digest panel: summary, decisions list, topics (click →
  filters), files edited, models, dates, related sessions (click → navigate),
  and a "Search raw transcript" box that calls the excerpt endpoint on
  demand (never automatically — mirrors the MCP token-cost discipline).

**Graph page**
- Cytoscape force layout: topic nodes as hubs (size ∝ degree), session nodes
  colored by project and sized by message count, project nodes optional
  toggle. Same filter chips as Sessions.
- Click session → same digest panel + the node expands to show its files
  and related sessions (fetched on demand); click again collapses.
- Hover → tooltip with title/date. Reset-layout button. Legend.

**Projects page**
- Table: project path (shortened, full on hover), sessions, last activity,
  digest coverage bar, top 3 topics. Click → Sessions page filtered to it.

## 7. Build & packaging

- `ui/package.json`-free: frontend deps live in the root `package.json` as
  devDependencies (react, react-dom, vite, @vitejs/plugin-react, cytoscape,
  types); `ui/vite.config.ts` outputs to `dist/ui/`.
- Root scripts: `build` = `tsc && vite build --config ui/vite.config.ts`;
  `dev:ui` = vite dev server with `/api` proxy.
- `package.json` `files` includes `dist/` so the published tarball ships the
  built UI. Server resolves `dist/ui/` relative to its own file, not cwd.

## 8. Testing

- **Server:** integration tests per endpoint against a seeded `:memory:`
  store (same style as `tests/mcp.test.ts`): status counts, list vs search
  paths, filters, 404/400 handling, graph shape.
- **Store additions:** unit tests for `listSessions` filters/paging,
  `graphData` node/edge correctness under filters, `projectStats`.
- **Frontend:** light — Vitest + Testing Library smoke tests for the search
  flow (debounce → fetch → render) and graph data → Cytoscape element
  mapping; one screenshot pass per page for visual verification. High UI
  coverage is explicitly not a v1 goal.

## 9. Future phase — Remote Access (designed, NOT in this plan)

Motivation: use the knowledge from another machine — both as a human (open
the UI from a laptop) and as Claude (a Claude Code session elsewhere calling
`search_sessions` against this machine's store).

Chosen model: **hub**, not sync. One machine holds the store; others query it.
- `totalrecall serve --remote --token <secret>`: binds beyond localhost and
  serves (a) the same web UI and (b) the MCP tools over **HTTP transport**
  (`/mcp`), bearer-token protected. Other machines register it with
  `claude mcp add totalrecall-remote --transport http <url>/mcp --header
  "Authorization: Bearer <token>"` — same five tools, no second database.
- Optional: `hook-run --remote <url>` on satellite machines posts their
  session digests to the hub so their sessions are indexed too.
- **Security stance:** designed to sit behind Tailscale/SSH tunnel; the token
  is defense-in-depth, not the only wall. Never recommend open-internet
  exposure of one's entire coding history.
- Sync/replication between machines: explicitly rejected (conflicts, merges,
  unnecessary for a single user).

This phase reuses the HTTP server built here; it is scoped as its own spec +
plan after the web UI ships.

## 10. Out of scope (v1 web UI)

Auth, remote binding, write actions (backfill/re-digest from the browser),
editing digests, files in the default graph, Neo4j (separate phase),
mobile-specific layout.
