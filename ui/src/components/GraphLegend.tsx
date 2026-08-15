export default function GraphLegend() {
  const dot = (bg: string, shape = "50%") => <span style={{ display: "inline-block", width: 12, height: 12, background: bg, borderRadius: shape, marginRight: 6 }} />;
  return <div className="row muted" style={{ fontSize: 12, gap: 14 }}>
    <span>{dot("var(--accent)")}session (size = messages, color = project)</span>
    <span>{dot("#e6e8ee")}topic (size = sessions)</span>
    <span>{dot("var(--muted)", "3px")}project</span>
    <span>{dot("#9aa3b2", "2px")}file (on expand)</span>
    <span>click a session to expand · click again to collapse</span>
  </div>;
}
