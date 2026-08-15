import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type Filters, type ProjectStat, type SessionListRow } from "../api";
import { useDebounce } from "../hooks/useDebounce";
import FilterBar from "../components/FilterBar";
import SessionList from "../components/SessionList";
import DigestPanel from "../components/DigestPanel";

export default function SessionsPage() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const dq = useDebounce(q, 250);
  const [filters, setFilters] = useState<Filters>({ project: sp.get("project") ?? undefined });
  const [projects, setProjects] = useState<ProjectStat[]>([]);
  const [rows, setRows] = useState<SessionListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(sp.get("session"));
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.projects().then(setProjects).catch(() => {}); }, []);
  useEffect(() => {
    setLoading(true); setErr(null);
    api.sessions({ ...filters, q: dq || undefined, limit: 100 })
      .then(r => { setRows(r.rows); setTotal(r.total); })
      .catch(e => setErr(e.message)).finally(() => setLoading(false));
    const next = new URLSearchParams(); if (dq) next.set("q", dq); if (filters.project) next.set("project", filters.project);
    if (selected) next.set("session", selected); setSp(next, { replace: true });
  }, [dq, filters, selected]);

  const emptyDb = !loading && !dq && !filters.project && !filters.outcome && !filters.from && !filters.to && total === 0;
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Sessions</h2>
      <input className="input" placeholder="Search digests, decisions, topics…" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 12 }} />
      <FilterBar value={filters} onChange={setFilters} projects={projects} />
      {err && <p className="muted">Error: {err}</p>}
      {emptyDb ? (
        <div className="empty"><p>No sessions indexed yet.</p><p>Run <code>totalrecall backfill</code> to index your Claude Code history, then refresh.</p></div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: selected ? "1fr 420px" : "1fr", gap: 16 }}>
          <div>
            <p className="muted" style={{ fontSize: 13 }}>{loading ? "Loading…" : `${total} session${total === 1 ? "" : "s"}${dq ? " matching" : ""}`}</p>
            <SessionList rows={rows} selected={selected} onSelect={setSelected} />
          </div>
          <DigestPanel sessionId={selected} onClose={() => setSelected(null)} onNavigate={setSelected}
            onTopic={t => { setQ(t); }} />
        </div>
      )}
    </div>
  );
}
