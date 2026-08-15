import type { ElementDefinition } from "cytoscape";
import type { GraphNode, GraphEdge, SessionDetail } from "../api";

const PALETTE = ["#7c9cff", "#3ddc97", "#ffb454", "#ff6b6b", "#c084fc", "#22d3ee", "#f472b6", "#a3e635", "#fb923c", "#38bdf8"];
export function colorForProject(project: string): string {
  let h = 0; for (const ch of project) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function toElements(nodes: GraphNode[], edges: GraphEdge[]): ElementDefinition[] {
  const degree = new Map<string, number>();
  for (const e of edges) { degree.set(e.target, (degree.get(e.target) ?? 0) + 1); }
  const els: ElementDefinition[] = nodes.map(n => {
    const size = n.type === "session" ? 14 + Math.min(40, Math.log2(1 + (n.messageCount ?? 1)) * 4)
      : n.type === "topic" ? 16 + Math.min(40, (degree.get(n.id) ?? 0) * 3) : 22;
    return { data: { id: n.id, label: n.label, size, project: n.project, outcome: n.outcome, startedAt: n.startedAt,
      color: n.type === "session" && n.project ? colorForProject(n.project) : n.type === "project" ? colorForProject(n.label) : undefined },
      classes: n.type };
  });
  for (const e of edges) els.push({ data: { id: `${e.source}->${e.target}`, source: e.source, target: e.target }, classes: e.kind });
  return els;
}

export function fileElementsFor(s: Pick<SessionDetail, "sessionId" | "filesEdited">): ElementDefinition[] {
  const els: ElementDefinition[] = [];
  const seen = new Set<string>();
  for (const f of s.filesEdited) {
    if (seen.has(f)) continue; seen.add(f);
    const id = `file:${f}`;
    els.push({ data: { id, label: f.split(/[\\/]/).pop() ?? f, size: 10, title: f }, classes: "file" });
    els.push({ data: { id: `${s.sessionId}->${id}`, source: s.sessionId, target: id }, classes: "touched" });
  }
  return els;
}
