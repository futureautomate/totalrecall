import type { Filters, ProjectStat } from "../api";
import { shortPath } from "../lib/format";
export default function FilterBar({ value, onChange, projects }:
  { value: Filters; onChange: (f: Filters) => void; projects: ProjectStat[] }) {
  const set = (k: keyof Filters, v: string) => onChange({ ...value, [k]: v || undefined });
  return (
    <div className="row" style={{ marginBottom: 12 }}>
      <select className="input" style={{ width: 240 }} value={value.project ?? ""} onChange={e => set("project", e.target.value)}>
        <option value="">All projects</option>
        {projects.map(p => <option key={p.projectPath} value={p.projectPath}>{shortPath(p.projectPath)} ({p.sessionCount})</option>)}
      </select>
      <select className="input" style={{ width: 160 }} value={value.outcome ?? ""} onChange={e => set("outcome", e.target.value)}>
        <option value="">Any outcome</option><option>completed</option><option>ongoing</option><option>abandoned</option>
      </select>
      <input className="input" style={{ width: 160 }} type="date" value={value.from ?? ""} onChange={e => set("from", e.target.value)} />
      <span className="muted">to</span>
      <input className="input" style={{ width: 160 }} type="date" value={value.to ?? ""} onChange={e => set("to", e.target.value)} />
      {(value.project || value.outcome || value.from || value.to) &&
        <button className="btn" onClick={() => onChange({})}>Clear</button>}
    </div>
  );
}
