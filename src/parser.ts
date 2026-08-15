import fs from "node:fs";
import path from "node:path";
import type { ParsedSession, SessionMeta, CondensedMessage } from "./types.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const MAX_CONDENSED_CHARS = 2000;
const MAX_FIRST_PROMPT = 500;

function textOfContent(content: unknown): string {
  // message.content is either a string or an array of {type, text?, ...} blocks
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

export function parseSessionFile(filePath: string): ParsedSession {
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, "utf8");
  const meta: SessionMeta = {
    sessionId: "",
    projectPath: "",
    filePath,
    startedAt: null,
    endedAt: null,
    firstPrompt: null,
    aiTitle: null,
    gitBranch: null,
    models: [],
    messageCount: 0,
    filesEdited: [],
    fileMtimeMs: stat.mtimeMs,
    fileSize: stat.size,
  };
  const condensed: CondensedMessage[] = [];
  const models = new Set<string>();
  const files = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; } // malformed line: skip
    if (!obj || typeof obj !== "object") continue;

    if (obj.sessionId && typeof obj.sessionId === "string" && !meta.sessionId) meta.sessionId = obj.sessionId;
    if (obj.sessionId && !meta.projectPath && typeof obj.cwd === "string") meta.projectPath = obj.cwd;
    if (obj.type === "ai-title" && typeof obj.aiTitle === "string") meta.aiTitle = obj.aiTitle;

    if (obj.type !== "user" && obj.type !== "assistant") continue;
    meta.messageCount++;
    if (typeof obj.timestamp === "string") {
      if (!meta.startedAt) meta.startedAt = obj.timestamp;
      meta.endedAt = obj.timestamp;
    }
    if (typeof obj.gitBranch === "string" && obj.gitBranch && obj.gitBranch !== "HEAD") {
      meta.gitBranch = obj.gitBranch;
    }

    if (obj.type === "user" && !obj.isMeta) {
      const text = textOfContent(obj.message?.content);
      if (text) {
        if (!meta.firstPrompt) meta.firstPrompt = text.slice(0, MAX_FIRST_PROMPT);
        condensed.push({ role: "user", text: text.slice(0, MAX_CONDENSED_CHARS) });
      }
    }

    if (obj.type === "assistant") {
      const model = obj.message?.model;
      if (typeof model === "string") models.add(model);
      const text = textOfContent(obj.message?.content);
      if (text) condensed.push({ role: "assistant", text: text.slice(0, MAX_CONDENSED_CHARS) });
      const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
      for (const b of blocks) {
        if (b?.type === "tool_use" && EDIT_TOOLS.has(b.name) && typeof b.input?.file_path === "string") {
          files.add(b.input.file_path);
        }
      }
    }
  }

  meta.sessionId = meta.sessionId || path.basename(filePath, ".jsonl");
  meta.models = [...models];
  meta.filesEdited = [...files];
  return { meta, condensed };
}
