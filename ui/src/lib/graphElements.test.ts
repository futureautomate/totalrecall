import { describe, it, expect } from "vitest";
import { toElements, fileElementsFor, colorForProject } from "./graphElements";

describe("graph element mapping", () => {
  it("maps nodes/edges to cytoscape elements with classes and sizes", () => {
    const els = toElements(
      [{ id: "s1", type: "session", label: "Auth", project: "D:\\p", messageCount: 40, outcome: "completed" },
       { id: "topic:auth", type: "topic", label: "auth" }, { id: "project:D:\\p", type: "project", label: "D:\\p" }],
      [{ source: "s1", target: "topic:auth", kind: "about" }, { source: "s1", target: "project:D:\\p", kind: "in_project" }]);
    const s1 = els.find(e => e.data.id === "s1")!;
    expect(s1.classes).toContain("session");
    expect((s1.data as any).size).toBeGreaterThan(10);
    expect(els.filter(e => (e.data as any).source).length).toBe(2);
    expect(els.find(e => e.data.id === "topic:auth")!.classes).toContain("topic");
  });
  it("creates file nodes + edges for an expanded session, deduping by path", () => {
    const els = fileElementsFor({ sessionId: "s1", filesEdited: ["D:\\a.ts", "D:\\a.ts", "D:\\b.ts"] } as any);
    expect(els.filter(e => !(e.data as any).source).length).toBe(2);
    expect(els.filter(e => (e.data as any).source).length).toBe(2);
    expect(els[0].data.id).toBe("file:D:\\a.ts");
  });
  it("assigns a stable color per project", () => {
    expect(colorForProject("D:\\x")).toBe(colorForProject("D:\\x"));
    expect(colorForProject("D:\\x")).not.toBe(colorForProject("D:\\y"));
  });
});
