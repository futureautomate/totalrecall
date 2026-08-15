import type { SessionListRow } from "../api";
import { Highlight } from "../lib/highlight";
import { fmtDate, shortPath } from "../lib/format";
export default function SessionList({ rows, selected, onSelect }:
  { rows: SessionListRow[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map(r => (
        <div key={r.sessionId} className="card" role="button" tabIndex={0} onClick={() => onSelect(r.sessionId)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(r.sessionId); } }}
          style={{ cursor: "pointer", borderColor: selected === r.sessionId ? "var(--accent)" : undefined }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{r.title ?? r.aiTitle ?? r.firstPrompt ?? r.sessionId}</strong>
            {r.outcome && <span className={`badge ${r.outcome}`}>{r.outcome}</span>}
          </div>
          <div className="muted" style={{ fontSize: 13, margin: "4px 0" }}>{shortPath(r.projectPath)} · {fmtDate(r.startedAt)}</div>
          {r.snippet && <div style={{ fontSize: 14 }}><Highlight text={r.snippet} /></div>}
        </div>
      ))}
    </div>
  );
}
