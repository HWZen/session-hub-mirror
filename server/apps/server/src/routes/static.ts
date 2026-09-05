import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export function staticRoutes(distRoot: string): Hono {
  const app = new Hono();
  const root = path.resolve(distRoot);

  app.get("*", async (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    if (pathname === "/health" || pathname.startsWith("/health/") || pathname.startsWith("/v1/")) {
      return c.json({ error: "not found" }, 404);
    }
    const candidates = [pathname, "/index.html"];
    for (const candidate of candidates) {
      const filePath = path.join(root, candidate === "/" ? "/index.html" : candidate);
      const relative = path.relative(root, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      try {
        const content = await readFile(filePath);
        const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
        return c.body(new Uint8Array(content), 200, { "content-type": mime });
      } catch {
        continue;
      }
    }
    return c.json({ error: "not found" }, 404);
  });

  return app;
}
