// Cloudflare Workers entry point.
//
// - POST /actions  { action: string, args: object } -> JSON result
//   (same RPC contract as the Bun server in server/src/index.ts, but the
//   handlers run against a D1 database via the DB binding)
// - everything else is delegated to Workers Static Assets (client/dist),
//   which is configured with single-page-application fallback in
//   wrangler.toml.
//
// Initial data (2 shops + default menus) is seeded lazily by the getState
// action itself (seedIfEmpty), so a freshly migrated D1 database needs no
// separate seed step.

import { drizzle } from "drizzle-orm/d1";
import { Actions } from "./src/actions";
import type { ActionDef, Ctx } from "./src/framework";
import * as schema from "./src/schema";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

function createWorkerCtx(env: Env): Ctx {
  const d1db = drizzle(env.DB, { schema });
  return {
    // The framework's Ctx is typed against the Bun SQLite driver. The D1
    // driver exposes the same query-builder API the handlers use, so the
    // handle is cast across (type-only mismatch, runtime-compatible).
    db: (() => d1db) as unknown as Ctx["db"],
    invalidateQueries: () => {
      // No-op on Workers too: the web client invalidates its own queries.
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAction = ActionDef<any, any>;
const actions = Actions as unknown as Record<string, AnyAction>;

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

async function handleAction(req: Request, env: Env): Promise<Response> {
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
    const result = await def.handler(createWorkerCtx(env), parsed.data);
    return Response.json(result ?? null);
  } catch (err) {
    console.error(`action ${action} failed`, err);
    return jsonError(500, err instanceof Error ? err.message : "internal error");
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/actions") {
      if (req.method !== "POST") return jsonError(405, "POST only");
      return handleAction(req, env);
    }
    // Static assets (SPA fallback handled by the assets configuration).
    return env.ASSETS.fetch(req);
  },
};
