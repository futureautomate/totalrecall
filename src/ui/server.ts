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

/** dist/ui-static next to the compiled server file: dist/ui/server.js -> dist/ui-static/ ... */
export function defaultStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));      // .../dist/ui  (or src/ui under tsx)
  return path.resolve(here, "..", "ui-static");                    // .../dist/ui-static
}

export function createUiServer(store: SessionStore, opts: { staticDir?: string } = {}): http.Server {
  const router = new Router();
  registerApi(router, store);
  const staticDir = opts.staticDir ?? defaultStaticDir();

  return http.createServer(async (req, res) => {
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
    res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
    fs.createReadStream(target).pipe(res);
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
