import { useEffect, useState } from "react";
import { api, type StatusDto } from "../api";
export default function StatusBar() {
  const [s, setS] = useState<StatusDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.status().then(setS).catch(e => setErr(String(e.message))); }, []);
  if (err) return <footer className="status">Status unavailable: {err}</footer>;
  if (!s) return <footer className="status">Loading status…</footer>;
  const pct = s.sessions ? Math.round((s.digested / s.sessions) * 100) : 0;
  return (
    <footer className="status">
      <span>{s.sessions} sessions · {s.projects} projects</span>
      <span>{pct}% digested</span>
      {s.pending + s.failed > 0 && <span>{s.pending + s.failed} pending → run <code>totalrecall digest-pending</code></span>}
      <span style={{ marginLeft: "auto" }} title={s.dbPath}>db: {s.dbPath}</span>
    </footer>
  );
}
