import { describe, it, expect } from "vitest";
import { parseSessionFile } from "../src/parser.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (f: string) => path.join(__dirname, "fixtures", f);

describe("parseSessionFile", () => {
  it("extracts metadata from a clean session", () => {
    const { meta, condensed } = parseSessionFile(fx("basic-session.jsonl"));
    expect(meta.sessionId).toBe("aaa-111");
    expect(meta.projectPath).toBe("D:\\Projects\\demo");
    expect(meta.aiTitle).toBe("Fix login bug");
    expect(meta.firstPrompt).toContain("login page throws a 500");
    expect(meta.firstPrompt).not.toContain("caveat");         // isMeta lines skipped
    expect(meta.gitBranch).toBe("main");
    expect(meta.models).toEqual(["claude-fable-5"]);
    expect(meta.filesEdited).toEqual(["D:\\Projects\\demo\\src\\login.ts"]);
    expect(meta.startedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(meta.endedAt).toBe("2026-08-01T10:01:00.000Z");
    expect(meta.messageCount).toBe(5);                        // user+assistant lines
    // condensed: only human-meaningful text, no tool_result noise
    expect(condensed.some(m => m.text.includes("SQL string was unescaped"))).toBe(true);
    expect(condensed.every(m => m.text.length <= 2000)).toBe(true);
  });

  it("survives malformed and unknown lines", () => {
    const { meta } = parseSessionFile(fx("messy-session.jsonl"));
    expect(meta.sessionId).toBe("bbb-222");
    expect(meta.projectPath).toBe("D:\\Projects\\demo2");
    expect(meta.filesEdited).toEqual(["D:\\Projects\\demo2\\a.txt"]);
    expect(meta.models).toEqual(["claude-sonnet-5"]);
  });

  it("falls back to filename for sessionId when no JSON contains sessionId", () => {
    const { meta } = parseSessionFile(fx("empty-session.jsonl"));
    expect(meta.sessionId).toBe("empty-session");
    expect(meta.messageCount).toBe(0);
    expect(meta.projectPath).toBe("");
  });
});
