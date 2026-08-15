import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function dataDir(): string {
  const d = path.join(os.homedir(), ".totalrecall");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function dbPath(): string {
  return path.join(dataDir(), "index.db");
}

export function digesterCwd(): string {
  const d = path.join(dataDir(), "digester-cwd");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Claude Code encodes a project path into a directory name by replacing
// every character that is not [A-Za-z0-9-] with "-" (":", "\", "/", ".", etc).
export function encodeProjectPath(realPath: string): string {
  return realPath.replace(/[^A-Za-z0-9-]/g, "-");
}

export function excludedProjectDirs(): Set<string> {
  return new Set([encodeProjectPath(path.join(os.homedir(), ".totalrecall", "digester-cwd"))]);
}
