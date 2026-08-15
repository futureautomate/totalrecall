/** Renders store snippets where matches are wrapped as >>term<< */
export function Highlight({ text }: { text: string }) {
  const parts = text.split(/(>>.*?<<)/g);
  return <>{parts.map((p, i) => p.startsWith(">>") && p.endsWith("<<")
    ? <mark key={i}>{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>)}</>;
}
