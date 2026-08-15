# totalrecall — User Guide

How to actually use the app day to day. (What it is and how it works internally: see [README](../README.md) and [LEARNING.md](LEARNING.md).)

> **Golden rule:** after ANY code change in `src/`, run `npm run build`.
> The MCP server and the SessionEnd hook run the compiled `dist/cli.js`, not your source —
> stale `dist` means your changes silently don't apply to them.

## Running commands

All commands run from the project folder (`D:\Projects\totalrecall`). Two equivalent forms:

```
npx tsx src/cli.ts <command>     # runs TypeScript directly (dev)
node dist/cli.js <command>       # runs the built app (what hook/MCP use)
```

## Everyday use

### Search your session history (terminal)

```
npx tsx src/cli.ts search flutter
npx tsx src/cli.ts search caddy deploy --limit 5
npx tsx src/cli.ts search auth --project pocketpass
```

Results show `[session-id] title — project`, date, outcome, and a snippet with
`>>match<<` highlighting. Search only matches digested sessions' summaries,
decisions, topics, titles, and first prompts.

`--project` is a forgiving filter: case-insensitive, and any substring of the
stored project path works — a folder name like `pethbhar-webapp` is enough.
Caveat: sessions record the path a project had *at the time* — if you moved a
repo on disk, its old sessions are stored under the old path (they still match
a folder-name fragment as long as the folder name didn't change).

### Search from inside a Claude Code session (the main point of the app)

Any Claude session on this machine can use the `totalrecall` MCP tools. Just ask naturally:

- *"Search my past sessions for the JWT auth work"* → `search_sessions`
- *"Get the full digest of that session"* → `get_session_digest`
- *"Pull the exact part where we fixed the SQL bug"* → `get_session_excerpt` (raw transcript drill-down — token-costlier, use when the digest isn't enough)
- *"What sessions are related to this one?"* → `related_sessions`
- *"Which projects have indexed sessions?"* → `list_projects`

Typical flow when starting fresh on something you did before:
**search → read digest → only then excerpt.** That order is what saves tokens.

### Ending sessions = automatic indexing

Nothing to do. The SessionEnd hook indexes and digests each session when it ends
(takes up to a few minutes for big sessions — it runs a headless Haiku call).
The currently-active session is never indexed (2-minute activity window).

## Maintenance

| When | Run |
|---|---|
| Sessions missing from search | `npx tsx src/cli.ts backfill` (skips everything unchanged; safe to re-run anytime) |
| Fast metadata-only refresh | `npx tsx src/cli.ts backfill --no-digest` |
| Retry failed/pending digests | `npx tsx src/cli.ts digest-pending` (add `--timeout 600` for slow/huge sessions) |
| Index one specific session | `npx tsx src/cli.ts index --session "C:\Users\tejas\.claude\projects\<dir>\<id>.jsonl"` |
| After editing src/ | `npm run build` (then hook/MCP pick up changes) |
| Run tests | `npm test` |

## Where things live

- **Database:** `~/.totalrecall/index.db` (single SQLite file — this IS the knowledge base; back it up if you care)
- **Digester scratch:** `~/.totalrecall/digester-cwd/` (headless claude runs execute here; excluded from indexing — leave it alone)
- **Session sources:** `~/.claude/projects/<encoded-path>/<session-id>.jsonl` (owned by Claude Code, read-only to us)
- **Hook registration:** `~/.claude/settings.json` → `hooks.SessionEnd` (command contains the word `totalrecall`)
- **MCP registration:** user scope — check with `claude mcp list` (expect `totalrecall … ✔ Connected`)

## Troubleshooting

**A session never shows up in search**
1. Is it still the active session? It's skipped until ~2 min after last activity.
2. `npx tsx src/cli.ts digest-pending` — it may have a failed digest. Huge
   transcripts are automatically condensed to head+tail before digesting; if a
   digest still times out, retry with `--timeout 600` (or set
   `TOTALRECALL_DIGEST_TIMEOUT_MS` for the hook/backfill default).
3. Searching with a `project` filter? If the repo moved on disk, old sessions
   live under the old path — filter by folder name, or drop the filter.

**MCP tools missing in a Claude session**
- `claude mcp list` must show totalrecall Connected. If not: `claude mcp add totalrecall -s user -- node "D:\Projects\totalrecall\dist\cli.js" mcp`
- Sessions started *before* registration don't have the tools — start a new session.

**Hook doesn't seem to index anything**
- Check `~/.claude/settings.json` still has the SessionEnd entry (`hook-run totalrecall`).
- Re-install safely (idempotent): `npm run build` then `npx tsx src/cli.ts install-hook`.
- The hook never errors visibly by design (always exits 0) — test manually by running `digest-pending` and checking search.

**Reset everything**
Delete `~/.totalrecall/index.db`, then `npx tsx src/cli.ts backfill`. Nothing else stores state.

**Uninstall**
Remove the SessionEnd block from `~/.claude/settings.json`, run `claude mcp remove totalrecall`, delete `~/.totalrecall/`.

## Not built yet (planned)

- `totalrecall ui` — local web app (Sessions / Graph / Projects)
- `totalrecall export neo4j` — graph exploration with Cypher

---
*Maintenance note: this guide is a living document — update it whenever commands,
tool names, file locations, or workflows change. Keep it grounded in what the code
actually does; no aspirational features outside the "Not built yet" section.*
