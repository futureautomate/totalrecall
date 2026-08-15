import { describe, it, expect } from "vitest";
import {
  digestSession, extractJson, capCondensed,
  CHUNK_CHAR_LIMIT, MAX_DIGEST_INPUT_CHARS,
} from "../src/digester.js";
import type { CondensedMessage } from "../src/types.js";

// A monster transcript (~950k chars) like real 50MB session files condense to.
function hugeTranscript(): CondensedMessage[] {
  return Array.from({ length: 500 }, (_, i) => ({
    role: "user" as const, text: `m${i} ` + "x".repeat(1900),
  }));
}

describe("capCondensed", () => {
  it("returns input unchanged when under the cap", () => {
    const small: CondensedMessage[] = [{ role: "user", text: "hello" }];
    expect(capCondensed(small)).toBe(small);
  });

  it("caps a huge transcript to head+tail with an omission marker", () => {
    const capped = capCondensed(hugeTranscript());
    const total = capped.reduce((n, m) => n + m.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_DIGEST_INPUT_CHARS + 200); // marker slack
    expect(capped[0].text).toContain("m0 ");                          // head kept
    expect(capped[capped.length - 1].text).toContain("m499 ");        // tail kept
    expect(capped.some(m => m.text.includes("omitted"))).toBe(true);  // gap marked
  });
});

const validDigestJson = JSON.stringify({
  title: "Auth work", summary: "Did auth things across the session in detail.",
  decisions: ["use JWT"], outcome: "completed", topics: ["auth", "jwt", "api"],
});

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson(validDigestJson).title).toBe("Auth work");
  });
  it("parses JSON wrapped in fences and prose", () => {
    const wrapped = "Here you go:\n```json\n" + validDigestJson + "\n```\nDone!";
    expect(extractJson(wrapped).outcome).toBe("completed");
  });
  it("throws on garbage", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("digestSession", () => {
  const small: CondensedMessage[] = [
    { role: "user", text: "add auth" },
    { role: "assistant", text: "added JWT auth" },
  ];

  it("single chunk: one claude call, validated digest", async () => {
    const prompts: string[] = [];
    const runner = async (p: string) => { prompts.push(p); return validDigestJson; };
    const d = await digestSession(small, runner);
    expect(d.title).toBe("Auth work");
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("add auth");         // transcript included
    expect(prompts[0]).toContain("JSON");             // format instructions included
  });

  it("clamps out-of-range values", async () => {
    const bad = JSON.stringify({ title: "x", summary: "y", decisions: "not-an-array",
      outcome: "weird", topics: ["a","b","c","d","e","f","g","h","i","j"] });
    const d = await digestSession(small, async () => bad);
    expect(d.decisions).toEqual([]);
    expect(d.outcome).toBe("ongoing");                 // invalid outcome → ongoing
    expect(d.topics.length).toBeLessThanOrEqual(8);
  });

  it("long transcript: chunk summaries then rollup", async () => {
    const long: CondensedMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: "user" as const, text: `message ${i} ` + "x".repeat(1900),
    }));
    const calls: string[] = [];
    const runner = async (p: string) => {
      calls.push(p);
      return p.includes("PARTIAL SUMMARY") ? "partial summary text" : validDigestJson;
    };
    const d = await digestSession(long, runner);
    expect(calls.length).toBeGreaterThan(1);           // chunked
    expect(d.title).toBe("Auth work");                 // final rollup digest
  });

  // Without the input cap, a real 50MB session condensed to ~950k chars would
  // fan out into ~20+ chunk calls (and real ones hit hundreds) — the cap must
  // bound the whole digest to a handful of claude calls.
  it("bounds claude calls for a huge transcript", async () => {
    const calls: string[] = [];
    const runner = async (p: string) => {
      calls.push(p);
      return p.includes("PARTIAL SUMMARY") ? "partial summary text" : validDigestJson;
    };
    const d = await digestSession(hugeTranscript(), runner);
    const maxCalls = Math.ceil(MAX_DIGEST_INPUT_CHARS / CHUNK_CHAR_LIMIT) + 1; // chunks + rollup
    expect(calls.length).toBeLessThanOrEqual(maxCalls);
    expect(d.title).toBe("Auth work");
  });
});
