import { describe, it, expect } from "vitest";
import type { SessionMeta } from "../src/types.js";

describe("scaffold", () => {
  it("types are importable", () => {
    const m: Partial<SessionMeta> = { sessionId: "x" };
    expect(m.sessionId).toBe("x");
  });
});
