export interface StatusDto { sessions: number; projects: number; digested: number; pending: number; failed: number; dbPath: string; }
export interface SessionListRow { sessionId: string; projectPath: string; title: string | null; aiTitle: string | null; firstPrompt?: string | null; startedAt: string | null; outcome: string | null; digestStatus?: string; snippet: string; }
export interface SessionDetail { sessionId: string; projectPath: string; startedAt: string|null; endedAt: string|null; firstPrompt: string|null; aiTitle: string|null; gitBranch: string|null; models: string[]; messageCount: number; digestStatus: string; digestTitle: string|null; digestSummary: string|null; decisions: string[]; outcome: string|null; topics: string[]; filesEdited: string[]; }
export interface ProjectStat { projectPath: string; sessionCount: number; lastActivity: string | null; digested: number; pending: number; failed: number; topTopics: string[]; }
export interface GraphNode { id: string; type: "session"|"topic"|"project"; label: string; project?: string; outcome?: string|null; messageCount?: number; startedAt?: string|null; }
export interface GraphEdge { source: string; target: string; kind: "about"|"in_project"; }
export interface Filters { project?: string; outcome?: string; from?: string; to?: string; }

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error((b as any).error ?? `HTTP ${r.status}`); }
  return r.json() as Promise<T>;
}
const qs = (o: object) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (v !== undefined && v !== "" && v !== null) p.set(k, String(v));
  const s = p.toString(); return s ? `?${s}` : "";
};
export const api = {
  status: () => getJson<StatusDto>("/api/status"),
  projects: () => getJson<ProjectStat[]>("/api/projects"),
  sessions: (params: Filters & { q?: string; limit?: number; offset?: number }) =>
    getJson<{ rows: SessionListRow[]; total: number; mode: "list" | "search" }>(`/api/sessions${qs(params)}`),
  session: (id: string) => getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  related: (id: string) => getJson<{ sessionId: string; title: string | null; reason: string }[]>(`/api/sessions/${encodeURIComponent(id)}/related`),
  excerpt: (id: string, q: string) => getJson<{ snippets: string[]; error?: string }>(`/api/sessions/${encodeURIComponent(id)}/excerpt${qs({ q })}`),
  graph: (f: Filters) => getJson<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/graph${qs(f)}`),
};
