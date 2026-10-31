// Local web server: serves the built client and the /actions RPC endpoint.
//
// - POST /actions  { action: string, args: object } -> JSON result
// - GET  /*        static files from client/dist, SPA fallback to index.html
//
// Session handling: the session token is read from the `cal_session`
// cookie and handed to the action handlers via a per-request Ctx; any
// Set-Cookie values the handlers queue (login / logout / edit link) are
// appended to the response.
//
// Migrations are applied automatically on startup. Initial demo data is
// inserted by `bun run db:migrate` (seedIfEmpty), not here.

import path from "node:path";
import { Actions, SESSION_COOKIE_NAME } from "./actions";
import { createCtx, runMigrations } from "./db";
import type { ActionDef, Ctx } from "./framework";

runMigrations();

const PORT = Number(process.env.PORT ?? 3000);
const clientDist = path.join(import.meta.dir, "..", "..", "client", "dist");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAction = ActionDef<any, any>;
const actions = Actions as unknown as Record<string, AnyAction>;

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function sessionTokenFrom(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      const value = rest.join("=");
      return value ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

function withCookies(res: Response, ctx: Ctx): Response {
  if (ctx.setCookies.length === 0) return res;
  const out = new Response(res.body, res);
  for (const c of ctx.setCookies) out.headers.append("set-cookie", c);
  return out;
}

async function handleAction(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "request body must be JSON");
  }
  const { action, args } = (body ?? {}) as { action?: unknown; args?: unknown };
  if (typeof action !== "string") {
    return jsonError(400, "missing action name");
  }
  const def = actions[action];
  if (!def) {
    return jsonError(400, `unknown action: ${action}`);
  }
  const parsed = def.request.safeParse(args ?? {});
  if (!parsed.success) {
    return jsonError(400, `invalid args for ${action}: ${parsed.error.message}`);
  }
  const ctx = createCtx({
    sessionToken: sessionTokenFrom(req),
    secureCookie: new URL(req.url).protocol === "https:",
  });
  try {
    const result = await def.handler(ctx, parsed.data);
    return withCookies(Response.json(result ?? null), ctx);
  } catch (err) {
    console.error(`action ${action} failed`, err);
    return jsonError(500, err instanceof Error ? err.message : "internal error");
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(clientDist, rel));
  if (filePath.startsWith(clientDist)) {
    const file = Bun.file(filePath);
    if ((await file.exists()) && file.size > 0) {
      return new Response(file);
    }
  }
  // SPA fallback
  const index = Bun.file(path.join(clientDist, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": "text/html" } });
  }
  return new Response(
    "client is not built yet — run `bun run build:client` (or `bun run dev`)",
    { status: 503 },
  );
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/actions") {
      if (req.method !== "POST") return jsonError(405, "POST only");
      return handleAction(req);
    }
    if (req.method === "GET") {
      return serveStatic(url.pathname);
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`barber-reservation server: http://localhost:${server.port}`);
