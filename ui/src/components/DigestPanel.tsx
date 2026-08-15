import { useEffect, useState } from "react";
import { api, type SessionDetail } from "../api";
import { fmtDate, shortPath } from "../lib/format";
export default function DigestPanel({ sessionId, onClose, onNavigate, onTopic }:
  { sessionId: string | null; onClose: () => void; onNavigate: (id: string) => void; onTopic: (t: string) => void }) {
  const [d, setD] = useState<SessionDetail | null>(null);
  const [related, setRelated] = useState<{ sessionId: string; title: string | null; reason: string }[]>([]);
  const [q, setQ] = useState(""); const [snips, setSnips] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null); setSnips(null); setQ(""); setErr(null);
    if (!sessionId) return;
    api.session(sessionId).then(setD).catch(e => setErr(e.message));
    api.related(sessionId).then(setRelated).catch(() => setRelated([]));
  }, [sessionId]);
  if (!sessionId) return null;
  return (
    <aside className="card" style={{ position: "sticky", top: 0, maxHeight: "calc(100vh - 80px)", overflow: "auto" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{d?.digestTitle ?? d?.aiTitle ?? sessionId}</strong>
        <button className="btn" onClick={onClose}>✕</button>
      </div>
      {err && <p className="muted">{err}</p>}
      {d && <>
        <p className="muted" style={{ fontSize: 13 }}>{shortPath(d.projectPath)} · {fmtDate(d.startedAt)} → {fmtDate(d.endedAt)} · {d.messageCount} msgs
          {d.outcome && <> · <span className={`badge ${d.outcome}`}>{d.outcome}</span></>}</p>
        {d.digestStatus !== "done" && <p className="muted">No digest yet ({d.digestStatus}) — run <code>totalrecall digest-pending</code>.</p>}
        {d.digestSummary && <p>{d.digestSummary}</p>}
        {d.decisions.length > 0 && <><h4>Decisions</h4><ul>{d.decisions.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
        {d.topics.length > 0 && <div className="row">{d.topics.map(t => <button key={t} className="badge" onClick={() => onTopic(t)}>{t}</button>)}</div>}
        {d.filesEdited.length > 0 && <><h4>Files edited</h4><ul style={{ fontSize: 13 }}>{d.filesEdited.map(f => <li key={f}><code>{f}</code></li>)}</ul></>}
        {d.models.length > 0 && <p className="muted" style={{ fontSize: 12 }}>models: {d.models.join(", ")}</p>}
        {related.length > 0 && <><h4>Related</h4><ul>{related.map(r => <li key={r.sessionId}>
          <a href="#" onClick={e => { e.preventDefault(); onNavigate(r.sessionId); }}>{r.title ?? r.sessionId}</a> <span className="muted">— {r.reason}</span></li>)}</ul></>}
        <h4>Search raw transcript</h4>
        <div className="row"><input className="input" placeholder="term to find in the transcript" value={q} onChange={e => setQ(e.target.value)} />
          <button className="btn" onClick={() => api.excerpt(sessionId, q).then(r => setSnips(r.snippets)).catch(e => setErr(e.message))} disabled={!q.trim()}>Find</button></div>
        {snips && (snips.length === 0 ? <p className="muted">No matches.</p> :
          <ul style={{ fontSize: 13 }}>{snips.map((s, i) => <li key={i}><pre style={{ whiteSpace: "pre-wrap" }}>{s}</pre></li>)}</ul>)}
      </>}
    </aside>
  );
}
