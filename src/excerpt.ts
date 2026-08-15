import { parseSessionFile } from "./parser.js";

export function getSessionExcerpt(
  filePath: string, query: string, maxSnippets = 5,
): string[] {
  const { condensed } = parseSessionFile(filePath);
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
  if (terms.length === 0) return [];
  const scored = condensed
    .map(m => {
      const lower = m.text.toLowerCase();
      const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
      return { text: `${m.role}: ${m.text}`.slice(0, 700), score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, maxSnippets).map(s => s.text);
}
