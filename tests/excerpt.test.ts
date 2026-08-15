import { describe, it, expect } from "vitest";
import { getSessionExcerpt } from "../src/excerpt.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = path.join(__dirname, "fixtures", "basic-session.jsonl");

describe("getSessionExcerpt", () => {
  it("returns messages matching the query, best first", () => {
    const snippets = getSessionExcerpt(fx, "SQL unescaped");
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0]).toContain("SQL string was unescaped");
  });
  it("returns empty array when nothing matches", () => {
    expect(getSessionExcerpt(fx, "kubernetes helm chart")).toEqual([]);
  });
  it("caps snippet length", () => {
    for (const s of getSessionExcerpt(fx, "login")) expect(s.length).toBeLessThanOrEqual(700);
  });
});
