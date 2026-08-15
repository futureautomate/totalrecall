import fs from "node:fs";
import path from "node:path";
import { parseSessionFile } from "./parser.js";
import { claudeProjectsDir, excludedProjectDirs } from "./paths.js";
import type { SessionStore } from "./store.js";
import { digestSession, type ClaudeRunner } from "./digester.js";

const ACTIVE_WINDOW_MS = 2 * 60_000;

export function scanSessionFiles(): string[] {
  const root = claudeProjectsDir();
  if (!fs.existsSync(root)) return [];
  const excluded = excludedProjectDirs();
  const out: string[] = [];
  for (const dir of fs.readdirSync(root)) {
    if (excluded.has(dir)) continue;
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith(".jsonl")) out.push(path.join(full, f));
    }
  }
  return out;
}

export async function indexSessionFile(
  filePath: string, store: SessionStore, run: ClaudeRunner | null,
): Promise<"indexed" | "skipped-unchanged" | "skipped-active"> {
  const stat = fs.statSync(filePath);
  if (Date.now() - stat.mtimeMs < ACTIVE_WINDOW_MS) return "skipped-active";
  if (store.isUnchanged(filePath, stat.mtimeMs, stat.size)) {
    // digest may still be pending from an earlier failed run
    const existing = store.getSession(path.basename(filePath, ".jsonl"));
    if (!run || existing?.digestStatus === "done") return "skipped-unchanged";
  }
  const { meta, condensed } = parseSessionFile(filePath);
  store.upsertSession(meta);
  if (run && condensed.length > 0) {
    try {
      const digest = await digestSession(condensed, run);
      store.setDigest(meta.sessionId, digest);
    } catch (e) {
      console.error(`digest failed for ${meta.sessionId}: ${String(e)}`);
      store.markDigestFailed(meta.sessionId);
    }
  }
  return "indexed";
}

export async function backfill(
  store: SessionStore, run: ClaudeRunner | null,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const files = scanSessionFiles();
  let done = 0;
  for (const f of files) {
    try { await indexSessionFile(f, store, run); }
    catch (e) { console.error(`failed to index ${f}: ${String(e)}`); }
    onProgress?.(++done, files.length);
  }
}
