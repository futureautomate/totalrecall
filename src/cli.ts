import path from "node:path";
import { Command } from "commander";
import { SessionStore } from "./store.js";
import { dbPath, digesterCwd, excludedProjectDirs } from "./paths.js";
import { makeClaudeRunner } from "./claude-runner.js";
import { indexSessionFile, backfill, scanSessionFiles } from "./indexer.js";

const program = new Command();
program.name("totalrecall").description("Claude Code session knowledge base");

// --timeout is given in seconds on the CLI; makeClaudeRunner wants ms.
function timeoutOpt(opts: { timeout?: string }): { timeoutMs?: number } {
  const s = opts.timeout ? parseInt(opts.timeout, 10) : NaN;
  return Number.isFinite(s) && s > 0 ? { timeoutMs: s * 1000 } : {};
}

program.command("index")
  .description("Index one session file (or all changed sessions)")
  .option("--session <path>", "path to a specific session .jsonl")
  .option("--no-digest", "skip LLM digest, metadata only")
  .option("--timeout <seconds>", "per-call claude -p timeout (default 180)")
  .action(async (opts) => {
    const store = new SessionStore(dbPath());
    const run = opts.digest ? makeClaudeRunner(timeoutOpt(opts)) : null;
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
  .option("--timeout <seconds>", "per-call claude -p timeout (default 180)")
  .action(async (opts) => {
    const files = scanSessionFiles();
    console.log(`${files.length} session files found.`);
    if (opts.digest) console.log(`Digesting with claude -p (haiku); this is slow — expect a few seconds per session.`);
    const store = new SessionStore(dbPath());
    const run = opts.digest ? makeClaudeRunner(timeoutOpt(opts)) : null;
    await backfill(store, run, (d, t) => process.stdout.write(`\r${d}/${t} indexed`));
    console.log("\ndone");
    store.close();
  });

program.command("search <query...>")
  .description("Search session digests")
  .option("--project <path>", "project filter (case-insensitive substring, e.g. a folder name)")
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
  .option("--timeout <seconds>", "per-call claude -p timeout (default 180)")
  .action(async (opts) => {
    const store = new SessionStore(dbPath());
    const run = makeClaudeRunner(timeoutOpt(opts));
    const pending = store.sessionsNeedingDigest();
    console.log(`${pending.length} sessions need digests`);
    for (const row of pending) {
      await indexSessionFile(row.filePath, store, run).catch(e => console.error(String(e)));
    }
    store.close();
  });

program.command("mcp")
  .description("Run the totalrecall MCP server on stdio")
  .action(async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { buildMcpServer } = await import("./mcp.js");
    const store = new SessionStore(dbPath());
    const server = buildMcpServer(store);
    await server.connect(new StdioServerTransport());
  });

program.command("hook-run")
  .description("SessionEnd hook entry: reads hook JSON from stdin, indexes that session")
  .argument("[marker]", "idempotency marker embedded by installHook, unused")
  .action(async () => {
    try {
      // Guard 1: any process spawned by the digester (claude-runner.ts) sets
      // this env var; a SessionEnd hook firing for the digester's own headless
      // run must not re-index/re-digest itself — that's the self-sustaining
      // claude -p chain this guard exists to break.
      if (process.env.TOTALRECALL_DIGESTER === "1") { process.exit(0); return; }

      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const payload = JSON.parse(input);
      const transcript = payload.transcript_path;
      if (typeof transcript === "string" && transcript.endsWith(".jsonl")) {
        // Guard 2: skip transcripts that live under an excluded project dir
        // (i.e. the digester's own cwd), checked from the raw path *before*
        // any parsing happens, so a malformed/huge transcript there can't
        // even be opened.
        const parentDirName = path.basename(path.dirname(transcript));
        if (excludedProjectDirs().has(parentDirName)) { process.exit(0); return; }

        const store = new SessionStore(dbPath());
        // ACTIVE_WINDOW check would always skip a just-ended session; bypass by
        // indexing directly when invoked from the hook:
        const { parseSessionFile } = await import("./parser.js");
        const { digestSession } = await import("./digester.js");
        const { meta, condensed } = parseSessionFile(transcript);

        // Guard 3 (belt and braces): even if the path-based guard above
        // somehow missed it, never index/digest a session whose *parsed*
        // cwd is the digester's own working directory.
        if (meta.projectPath === digesterCwd()) { store.close(); process.exit(0); return; }

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

program.command("ui")
  .description("Open the local web UI (sessions, graph, projects)")
  .option("--port <n>", "port to listen on", "4747")
  .option("--no-open", "don't open the browser automatically")
  .action(async (opts) => {
    const { startUi } = await import("./ui/server.js");
    try {
      const { url } = await startUi({ port: parseInt(opts.port, 10), open: opts.open });
      console.log(`TotalRecall UI → ${url}   (Ctrl-C to stop)`);
    } catch (e) {
      console.error(String((e as Error).message ?? e));
      process.exit(1);
    }
  });

program.parseAsync();
