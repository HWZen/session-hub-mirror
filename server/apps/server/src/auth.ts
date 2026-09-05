import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function bearerAuth(token: string) {
  return createMiddleware(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !safeCompare(match[1]!, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
}
