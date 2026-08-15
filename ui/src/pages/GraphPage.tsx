import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import { api, type Filters, type ProjectStat } from "../api";
import FilterBar from "../components/FilterBar";
import DigestPanel from "../components/DigestPanel";
import GraphLegend from "../components/GraphLegend";
import { toElements, fileElementsFor } from "../lib/graphElements";

const STYLE: cytoscape.StylesheetJson = [
  { selector: "node", style: { label: "data(label)", "font-size": 9, color: "#9aa3b2", "text-wrap": "ellipsis", "text-max-width": "120px", "text-valign": "bottom", "text-margin-y": 4, width: "data(size)", height: "data(size)" } },
  { selector: "node.session", style: { "background-color": "data(color)", "border-width": 1, "border-color": "#0f1115" } },
  { selector: "node.topic", style: { "background-color": "#e6e8ee", shape: "round-rectangle", "font-size": 11, color: "#e6e8ee", "text-valign": "center", "text-halign": "center", "text-max-width": "90px", "text-wrap": "ellipsis", "font-weight": "bold" } },
  { selector: "node.project", style: { "background-color": "data(color)", shape: "diamond", opacity: 0.85 } },
  { selector: "node.file", style: { "background-color": "#9aa3b2", shape: "rectangle" } },
  { selector: "edge", style: { width: 1, "line-color": "#2c313c", "curve-style": "haystack", "haystack-radius": 0.3 } },
  { selector: "edge.in_project", style: { "line-color": "#22262f", "line-style": "dashed" } },
  { selector: "edge.touched", style: { "line-color": "#6b7280" } },
  { selector: "node:selected", style: { "border-width": 3, "border-color": "#7c9cff" } },
  { selector: ".faded", style: { opacity: 0.15 } },
];

export default function GraphPage() {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [projects, setProjects] = useState<ProjectStat[]>([]);
  const [showProjects, setShowProjects] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [count, setCount] = useState({ nodes: 0, edges: 0 });
  const [empty, setEmpty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const expanded = useRef(new Set<string>());
  const reqId = useRef(0);

  useEffect(() => { api.projects().then(setProjects).catch(() => {}); }, []);

  useEffect(() => {
    if (!ref.current) return;
    const cy = cytoscape({ container: ref.current, style: STYLE, wheelSensitivity: 0.2 });
    cyRef.current = cy;
    cy.on("tap", "node.session", async (ev) => {
      const id = ev.target.id();
      setSelected(id);
      if (expanded.current.has(id)) {
        cy.remove(cy.$(`edge[source = "${id}"].touched`).connectedNodes(".file").filter(n => n.connectedEdges().length <= 1));
        cy.remove(cy.$(`edge[source = "${id}"].touched`));
        expanded.current.delete(id);
        return;
      }
      try {
        const d = await api.session(id);
        cy.add(fileElementsFor(d));
        expanded.current.add(id);
        cy.layout({ name: "cose", animate: true, animationDuration: 400, fit: false, randomize: false } as any).run();
      } catch (e: any) {
        setErr(e.message);
      }
    });
    cy.on("tap", "node.topic", (ev) => { const n = ev.target; cy.elements().addClass("faded"); n.closedNeighborhood().removeClass("faded"); });
    cy.on("tap", (ev) => { if (ev.target === cy) { cy.elements().removeClass("faded"); } });
    return () => { cy.destroy(); cyRef.current = null; };
  }, []);

  useEffect(() => {
    const cy = cyRef.current; if (!cy) return;
    const id = ++reqId.current;
    setErr(null);
    api.graph(filters).then(g => {
      if (id !== reqId.current) return;
      const nodes = showProjects ? g.nodes : g.nodes.filter(n => n.type !== "project");
      const edges = showProjects ? g.edges : g.edges.filter(e => e.kind !== "in_project");
      expanded.current.clear();
      cy.elements().remove();
      cy.add(toElements(nodes, edges));
      setCount({ nodes: nodes.length, edges: edges.length });
      setEmpty(nodes.length === 0);
      cy.layout({ name: "cose", animate: false, nodeRepulsion: () => 8000, idealEdgeLength: () => 60, gravity: 0.6, numIter: 800 } as any).run();
      cy.fit(undefined, 30);
    }).catch(e => { if (id === reqId.current) setErr(e.message); });
  }, [filters, showProjects]);

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto auto 1fr", height: "calc(100vh - 90px)", gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Graph</h2>
        <div className="row">
          <label className="muted" style={{ fontSize: 13 }}><input type="checkbox" checked={showProjects} onChange={e => setShowProjects(e.target.checked)} /> project nodes</label>
          <button className="btn" onClick={() => { cyRef.current?.layout({ name: "cose", animate: true } as any).run(); cyRef.current?.fit(undefined, 30); }}>Re-layout</button>
          <span className="muted" style={{ fontSize: 13 }}>{count.nodes} nodes · {count.edges} edges</span>
        </div>
      </div>
      <div><FilterBar value={filters} onChange={setFilters} projects={projects} /><GraphLegend />
        {err && <p className="muted">Error: {err}</p>}</div>
      <div style={{ display: "grid", gridTemplateColumns: selected ? "1fr 400px" : "1fr", gap: 12, minHeight: 0 }}>
        <div className="card" style={{ position: "relative", padding: 0, minHeight: 0 }}>
          <div ref={ref} style={{ position: "absolute", inset: 0 }} />
          {empty && <div className="empty" style={{ position: "absolute", inset: 0 }}><p>Nothing to draw yet.</p><p>Digested sessions carry topics — run <code>totalrecall backfill</code> or clear the filters.</p></div>}
        </div>
        <DigestPanel sessionId={selected} onClose={() => setSelected(null)} onNavigate={id => { setSelected(id); cyRef.current?.$id(id).select(); }}
          onTopic={t => {
            const cy = cyRef.current; if (!cy) return;
            const n = cy.$id("topic:" + t);
            if (n.nonempty()) { cy.elements().addClass("faded"); n.closedNeighborhood().removeClass("faded"); }
          }} />
      </div>
    </div>
  );
}
