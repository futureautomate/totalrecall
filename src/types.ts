export interface SessionMeta {
  sessionId: string;
  projectPath: string;      // decoded real path, e.g. D:\Projects\sessiontrack
  filePath: string;         // absolute path to the .jsonl
  startedAt: string | null; // ISO timestamp
  endedAt: string | null;
  firstPrompt: string | null; // first real (non-meta) user message, truncated to 500 chars
  aiTitle: string | null;
  gitBranch: string | null;
  models: string[];
  messageCount: number;       // user + assistant lines
  filesEdited: string[];      // absolute paths from Edit/Write/NotebookEdit tool calls
  fileMtimeMs: number;
  fileSize: number;
}

export interface CondensedMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ParsedSession {
  meta: SessionMeta;
  condensed: CondensedMessage[]; // for the digester; each text truncated to 2000 chars
}

export interface Digest {
  title: string;
  summary: string;          // 3–6 sentences
  decisions: string[];
  outcome: "completed" | "ongoing" | "abandoned";
  topics: string[];         // 3–8 lowercase tags
}

export type DigestStatus = "pending" | "done" | "failed" | "skipped";

export interface SearchResult {
  sessionId: string;
  projectPath: string;
  title: string | null;
  snippet: string;
  startedAt: string | null;
  outcome: string | null;
  rank: number;
}
