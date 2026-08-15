import { describe, it, expect, beforeEach } from "vitest";
import { indexSessionFile } from "../src/indexer.js";
import { SessionStore } from "../src/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const validDigestJson = JSON.stringify({
  title: "T", summary: "S", decisions: [], outcome: "completed", topics: ["x"],
});

function tempCopyOfFixture(name: string, ageMinutes: number): string {
  const src = path.join(__dirname, "fixtures", name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-test-"));
  const dst = path.join(dir, "aaa-111.jsonl");
  fs.copyFileSync(src, dst);
  const t = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(dst, t, t);
  return dst;
}

describe("indexSessionFile", () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(":memory:"); });

  it("indexes and digests an inactive session", async () => {
    const file = tempCopyOfFixture("basic-session.jsonl", 30);
    const result = await indexSessionFile(file, store, async () => validDigestJson);
    expect(result).toBe("indexed");
    const row = store.getSession("aaa-111")!;
    expect(row.digestStatus).toBe("done");
    expect(row.digestTitle).toBe("T");
  });

  it("skips a file modified under 2 minutes ago", async () => {
    const file = tempCopyOfFixture("basic-session.jsonl", 0);
    const result = await indexSessionFile(file, store, async () => validDigestJson);
    expect(result).toBe("skipped-active");
  });

  it("skips unchanged files on re-run", async () => {
    const file = tempCopyOfFixture("basic-session.jsonl", 30);
    await indexSessionFile(file, store, async () => validDigestJson);
    const second = await indexSessionFile(file, store, async () => validDigestJson);
    expect(second).toBe("skipped-unchanged");
  });

  it("stores metadata even when the digest run fails", async () => {
    const file = tempCopyOfFixture("basic-session.jsonl", 30);
    const result = await indexSessionFile(file, store, async () => { throw new Error("boom"); });
    expect(result).toBe("indexed");
    const row = store.getSession("aaa-111")!;
    expect(row.digestStatus).toBe("failed");
    expect(row.projectPath).toBe("D:\\Projects\\demo"); // metadata survived
  });
});
