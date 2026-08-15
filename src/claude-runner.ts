import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { digesterCwd } from "./paths.js";
import type { ClaudeRunner } from "./digester.js";

// Written once into digesterCwd(); passed to --mcp-config so digest runs
// don't load the user's real MCP servers. A plain file path (no embedded
// quotes/braces) is used instead of an inline JSON string because
// spawn(..., {shell:true}) on Windows joins argv with plain spaces (no
// per-arg quoting) before handing the whole line to cmd.exe — inline JSON
// containing `"`/`{`/`}` would corrupt that command line.
function emptyMcpConfigPath(): string {
  const p = path.join(digesterCwd(), "mcp-empty.json");
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({ mcpServers: {} }));
  return p;
}

// With shell:true on Windows, child.kill() only signals the cmd.exe shim,
// not the claude/node process tree beneath it — that leaks orphaned claude
// processes on timeout. taskkill /t kills the whole tree instead.
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  } else {
    child.kill();
  }
}

export function makeClaudeRunner(
  opts: { model?: string; timeoutMs?: number } = {},
): ClaudeRunner {
  const model = opts.model ?? "claude-haiku-4-5";
  const envTimeout = Number(process.env.SESSIONTRACK_DIGEST_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs
    ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 180_000);
  const mcpConfigPath = emptyMcpConfigPath();
  return (prompt: string) =>
    new Promise((resolve, reject) => {
      // shell:true so Windows resolves the `claude` .cmd shim
      const child = spawn("claude", [
        "-p", "--output-format", "json", "--model", model,
        "--strict-mcp-config", "--mcp-config", mcpConfigPath,
      ], {
        cwd: digesterCwd(), shell: true, windowsHide: true,
        // Marks any process tree spawned from this run (including a hook
        // firing off the digester's own SessionEnd) so hook-run can refuse
        // to re-index/re-digest it — breaks the self-sustaining chain.
        env: { ...process.env, SESSIONTRACK_DIGESTER: "1" },
      });
      let out = "", err = "";
      const timer = setTimeout(() => {
        killTree(child); reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
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
