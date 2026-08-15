import type { IncomingMessage, ServerResponse } from "node:http";

export type Handler = (
  req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL,
) => Promise<void> | void;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

interface Route { segments: string[]; handler: Handler; }

export class Router {
  private routes: Route[] = [];

  get(pattern: string, handler: Handler): void {
    this.routes.push({ segments: pattern.split("/").filter(Boolean), handler });
  }

  /** Returns false when no route matched (caller falls through to static). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== "GET") return false;
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = r.segments[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      try {
        await r.handler(req, res, params, url);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: String((e as Error)?.message ?? e) });
      }
      return true;
    }
    return false;
  }
}
