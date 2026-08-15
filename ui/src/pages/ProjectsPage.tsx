import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ProjectStat } from "../api";
import { fmtDate, shortPath } from "../lib/format";

export default function ProjectsPage() {
  const [rows, setRows] = useState<ProjectStat[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  useEffect(() => { api.projects().then(setRows).catch(e => setErr(e.message)); }, []);
  if (err) return <p className="muted">Error: {err}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  if (rows.length === 0) return <div className="empty"><p>No projects indexed yet.</p><p>Run <code>totalrecall backfill</code>.</p></div>;
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Projects</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr className="muted" style={{ textAlign: "left", fontSize: 13 }}>
          <th style={{ padding: 8 }}>Project</th><th>Sessions</th><th>Last activity</th><th style={{ width: 220 }}>Digest coverage</th><th>Top topics</th></tr></thead>
        <tbody>{rows.map(p => {
          const pct = p.sessionCount ? Math.round((p.digested / p.sessionCount) * 100) : 0;
          return (
            <tr key={p.projectPath} role="button" tabIndex={0}
              onClick={() => nav(`/sessions?project=${encodeURIComponent(p.projectPath)}`)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nav(`/sessions?project=${encodeURIComponent(p.projectPath)}`); } }}
              style={{ cursor: "pointer", borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: 10 }} title={p.projectPath}><strong>{shortPath(p.projectPath)}</strong><div className="muted" style={{ fontSize: 12 }}>{p.projectPath}</div></td>
              <td>{p.sessionCount}</td>
              <td className="muted" style={{ fontSize: 13 }}>{fmtDate(p.lastActivity)}</td>
              <td><div style={{ background: "var(--border)", borderRadius: 6, height: 8, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent-2)" }} /></div>
                <span className="muted" style={{ fontSize: 12 }}>{pct}% · {p.pending + p.failed} pending</span></td>
              <td className="row">{p.topTopics.map(t => <span key={t} className="badge">{t}</span>)}</td>
            </tr>);
        })}</tbody>
      </table>
    </div>
  );
}
