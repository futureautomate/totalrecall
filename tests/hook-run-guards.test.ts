import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { encodeProjectPath, digesterCwd } from "../src/paths.js";

// Live-incident regression: the SessionEnd hook fired for the digester's own
// headless `claude -p` runs (cwd = digesterCwd()), hook-run indexed+digested
// that transcript, spawning another `claude -p`, whose session end fired the
// hook again — a self-sustaining chain. Two guards in src/cli.ts hook-run
// stop this: an env guard (TOTALRECALL_DIGESTER=1, set by claude-runner.ts
// on every digester-spawned process) and a path guard (transcript's parent
// dir name is in excludedProjectDirs()).
//
// These tests exercise ONLY the guards (fast, no side effects). They
// deliberately do NOT exercise the full happy path (a real transcript
// getting parsed, upserted, and digested), because that path runs through
// the real dbPath() (~/.totalrecall/index.db) with no test-injection seam —
// driving it here would write into the user's real database. That stays a
// known gap; indexer.test.ts / store.test.ts cover indexSessionFile() and
// SessionStore directly against an in-memory (":memory:") DB instead.

const TSX_CLI = path.resolve("node_modules/tsx/dist/cli.mjs");
const CLI_ENTRY = path.resolve("src/cli.ts");
const GUARD_TIMEOUT_MS = 5000;

function runHookRun(opts: { env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<{ code: number | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, "hook-run"], {
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("hook-run did not exit within the guard timeout — guard likely not firing"));
    }, GUARD_TIMEOUT_MS + 3000);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, ms: Date.now() - start });
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

describe("hook-run guards (live-incident regression)", () => {
  it("env guard: exits 0 immediately when TOTALRECALL_DIGESTER=1, before touching stdin/DB", async () => {
    const { code, ms } = await runHookRun({ env: { TOTALRECALL_DIGESTER: "1" } });
    expect(code).toBe(0);
    expect(ms).toBeLessThan(GUARD_TIMEOUT_MS);
  }, 10_000);

  it("path guard: exits 0 fast for a transcript whose parent dir is the excluded digester-cwd dir", async () => {
    const excludedDirName = encodeProjectPath(digesterCwd());
    const fakeTranscript = path.join(os.homedir(), ".claude", "projects", excludedDirName, "fake-session.jsonl");
    const payload = JSON.stringify({ transcript_path: fakeTranscript });
    const { code, ms } = await runHookRun({ stdin: payload });
    expect(code).toBe(0);
    expect(ms).toBeLessThan(GUARD_TIMEOUT_MS);
  }, 10_000);
});
