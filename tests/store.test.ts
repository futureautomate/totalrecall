import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "../src/store.js";
import type { SessionMeta, Digest } from "../src/types.js";

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s1", projectPath: "D:\\Projects\\demo", filePath: "C:\\fake\\s1.jsonl",
    startedAt: "2026-08-01T10:00:00.000Z", endedAt: "2026-08-01T11:00:00.000Z",
    firstPrompt: "fix the login bug", aiTitle: "Fix login bug", gitBranch: "main",
    models: ["claude-fable-5"], messageCount: 5,
    filesEdited: ["D:\\Projects\\demo\\src\\login.ts"],
    fileMtimeMs: 1000, fileSize: 2000, ...over,
  };
}

const digest: Digest = {
  title: "Login 500 fix", summary: "Fixed a 500 caused by unescaped quotes in passwords.",
  decisions: ["Escape SQL strings at the boundary"], outcome: "completed",
  topics: ["login", "sql", "bugfix"],
};

describe("SessionStore", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(":memory:"); });

  it("upserts and reads back a session", () => {
    store.upsertSession(meta());
    const row = store.getSession("s1")!;
    expect(row.projectPath).toBe("D:\\Projects\\demo");
    expect(row.digestStatus).toBe("pending");
    expect(row.filesEdited).toEqual(["D:\\Projects\\demo\\src\\login.ts"]);
  });

  it("upsert twice does not duplicate and refreshes fields", () => {
    store.upsertSession(meta());
    store.upsertSession(meta({ messageCount: 9, fileMtimeMs: 3000 }));
    const row = store.getSession("s1")!;
    expect(row.messageCount).toBe(9);
  });

  it("isUnchanged matches on path+mtime+size", () => {
    store.upsertSession(meta());
    expect(store.isUnchanged("C:\\fake\\s1.jsonl", 1000, 2000)).toBe(true);
    expect(store.isUnchanged("C:\\fake\\s1.jsonl", 1001, 2000)).toBe(false);
    expect(store.isUnchanged("C:\\other.jsonl", 1000, 2000)).toBe(false);
  });

  it("setDigest stores digest and flips status; topics readable back", () => {
    store.upsertSession(meta());
    store.setDigest("s1", digest);
    const row = store.getSession("s1")!;
    expect(row.digestStatus).toBe("done");
    expect(row.digestTitle).toBe("Login 500 fix");
    expect(row.topics).toEqual(["login", "sql", "bugfix"]);
    expect(row.outcome).toBe("completed");
  });

  it("sessionsNeedingDigest lists pending and failed only", () => {
    store.upsertSession(meta());
    store.upsertSession(meta({ sessionId: "s2", filePath: "C:\\fake\\s2.jsonl" }));
    store.setDigest("s1", digest);
    const need = store.sessionsNeedingDigest();
    expect(need.map(r => r.sessionId)).toEqual(["s2"]);
  });

  // Important #2: undigested sessions were invisible to search because
  // session_fts only ever got a row from setDigest(). upsertSession must
  // seed a baseline FTS row too.
  it("an undigested session is findable by its first prompt", () => {
    store.upsertSession(meta({ firstPrompt: "debug the frobnicator overheating issue" }));
    const hits = store.searchSessions("frobnicator overheating");
    expect(hits.map(h => h.sessionId)).toContain("s1");
  });

  // Important #3: a --no-digest refresh of a session whose transcript file
  // changed (different mtime/size) must not leave a stale 'done' digest
  // sitting on top of newer content — status should flip back to 'pending'
  // so it gets picked up for re-digest.
  it("resets digest_status to pending when the underlying file changes", () => {
    store.upsertSession(meta());
    store.setDigest("s1", digest);
    expect(store.getSession("s1")!.digestStatus).toBe("done");

    store.upsertSession(meta({ fileMtimeMs: 9999 }));
    const row = store.getSession("s1")!;
    expect(row.digestStatus).toBe("pending");
    // old digest text columns are left in place until re-digested
    expect(row.digestTitle).toBe("Login 500 fix");

    const need = store.sessionsNeedingDigest();
    expect(need.map(r => r.sessionId)).toContain("s1");
  });

  it("does not reset digest_status when file mtime/size are unchanged", () => {
    store.upsertSession(meta());
    store.setDigest("s1", digest);
    store.upsertSession(meta({ messageCount: 42 })); // same fileMtimeMs/fileSize
    expect(store.getSession("s1")!.digestStatus).toBe("done");
  });

  // Regression: upsertSession's baseline FTS reseed (added for #2) must not
  // clobber an already-digested session's rich FTS row. A duplicate
  // hook-run firing (or any re-upsert of an unchanged, already-digested
  // session) should leave the digest text searchable.
  it("re-upserting an unchanged, already-digested session preserves searchable digest text", () => {
    store.upsertSession(meta());
    store.setDigest("s1", digest);
    expect(store.searchSessions("unescaped").map(h => h.sessionId)).toContain("s1");

    store.upsertSession(meta()); // same mtime/size as before — unchanged file
    const row = store.getSession("s1")!;
    expect(row.digestStatus).toBe("done");
    expect(store.searchSessions("unescaped").map(h => h.sessionId)).toContain("s1");
  });

  // Companion case: when the file *did* change (fix #3), the reseed to
  // baseline SHOULD happen — the old digest text is stale, so it's fine
  // (expected) for a summary-text search to no longer require a hit.
  it("re-upserting a changed, already-digested session reseeds FTS to baseline", () => {
    store.upsertSession(meta());
    store.setDigest("s1", digest);
    store.upsertSession(meta({ fileMtimeMs: 9999 })); // file changed
    const row = store.getSession("s1")!;
    expect(row.digestStatus).toBe("pending");
    // baseline row is seeded from title/first_prompt, not the stale digest summary
    expect(store.searchSessions("fix the login bug").map(h => h.sessionId)).toContain("s1");
  });
});
