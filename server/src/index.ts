// Local web server: serves the built client and the /actions RPC endpoint.
//
// - POST /actions  { action: string, args: object } -> JSON result
// - GET  /*        static files from client/dist, SPA fallback to index.html
//
// Migrations are applied automatically on startup (the seed data is NOT
// inserted here — run `bun run db:migrate` once for the initial data, or
// rely on the getState action, which also seeds an empty database).

import path from "node:path";
import { Actions } from "./actions";
import { createCtx, runMigrations } from "./db";
import type { ActionDef } from "./framework";

runMigrations();

const PORT = Number(process.env.PORT ?? 3000);
const clientDist = path.join(import.meta.dir, "..", "..", "client", "dist");
const ctx = createCtx();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAction = ActionDef<any, any>;
const actions = Actions as unknown as Record<string, AnyAction>;

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
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
  try {
    const result = await def.handler(ctx, parsed.data);
    return Response.json(result ?? null);
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
