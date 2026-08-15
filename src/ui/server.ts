import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Router, sendJson } from "./router.js";
import { registerApi } from "./api.js";
import { SessionStore } from "../store.js";
import { dbPath } from "../paths.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
};

/**
 * dist/ui-static next to the compiled server file: dist/ui/server.js -> dist/ui-static/ ...
 * Under `tsx` (dev/no-build runs), this file lives at src/ui/server.ts instead, where
 * `../ui-static` resolves to the nonexistent src/ui-static. Try the dist-relative
 * layout first, then fall back to the repo-root dist/ui-static so `tsx src/cli.ts ui`
 * can still serve an already-built bundle.
 */
export function defaultStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));      // .../dist/ui  (or src/ui under tsx)
  const candidates = [
    path.resolve(here, "..", "ui-static"),                         // .../dist/ui-static
    path.resolve(here, "..", "..", "dist", "ui-static"),            // .../src/ui -> <root>/dist/ui-static
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

/** Hostname part of a Host header, stripped of port; bracketed IPv6 literals unwrapped. */
function hostnameFrom(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(1, end);
  }
  const idx = hostHeader.lastIndexOf(":");
  return idx === -1 ? hostHeader : hostHeader.slice(0, idx);
}

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** DNS-rebinding guard: reject requests whose Host header doesn't name this local server. */
function isAllowedHost(hostHeader: string): boolean {
  return ALLOWED_HOSTS.has(hostnameFrom(hostHeader));
}

export function createUiServer(store: SessionStore, opts: { staticDir?: string } = {}): http.Server {
  const router = new Router();
  registerApi(router, store);
  const staticDir = opts.staticDir ?? defaultStaticDir();

  return http.createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host;
      if (hostHeader && !isAllowedHost(hostHeader)) {
        return sendJson(res, 403, { error: "forbidden host" });
      }
      if (await router.handle(req, res)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
      // static with SPA fallback
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.resolve(staticDir, rel);
      if (!file.startsWith(path.resolve(staticDir))) return sendJson(res, 403, { error: "forbidden" });
      const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(staticDir, "index.html");
      if (!fs.existsSync(target)) {
        return sendJson(res, 503, { error: "UI bundle not built. Run `npm run build` (needs dist/ui-static)." });
      }
      const stream = fs.createReadStream(target);
      // Defer headers until the file actually opens, so a race (ENOENT,
      // permission error, AV lock on Windows) between the existsSync check
      // above and the real read can still be reported as a clean error
      // instead of a half-written 200 response.
      stream.on("open", () => {
        res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
      });
      stream.on("error", () => {
        if (!res.headersSent) sendJson(res, 500, { error: "failed to read file" });
        else res.destroy();
      });
      stream.pipe(res);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: String((e as Error)?.message ?? e) });
    }
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
}

export function startUi(opts: { port: number; open: boolean }): Promise<{ url: string; close(): void }> {
  const store = new SessionStore(dbPath());
  const server = createUiServer(store);
  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") reject(new Error(`port ${opts.port} is in use — try --port <n>`));
      else reject(e);
    });
    server.listen(opts.port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${opts.port}`;
      if (opts.open) openBrowser(url);
      resolve({ url, close: () => { server.close(); store.close(); } });
    });
  });
}
