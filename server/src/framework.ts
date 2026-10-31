// Minimal local action framework (RPC layer for this app).
//
// An "action" is a named RPC endpoint described by a pair of zod schemas
// (request / response) plus a handler. The server (server/src/index.ts)
// validates incoming args against the request schema before dispatching,
// and the client (client/src/api.ts) derives its static types from the
// same definitions, so both ends stay in sync with no codegen.

import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";

export { z };

/** Context handed to every action handler. */
export interface Ctx {
  /** Drizzle database handle, typed against the given schema module. */
  db: <TSchema extends Record<string, unknown>>() => BunSQLiteDatabase<TSchema>;
  /**
   * Ask the client to refetch its queries. In this local setup the client
   * already invalidates its queries after every mutation, so this is a
   * no-op kept for API compatibility with the handlers.
   */
  invalidateQueries: () => void;
  /**
   * Raw session token from the request's session cookie, or null when the
   * request carries none. Handlers resolve it against the sessions table.
   */
  sessionToken: string | null;
  /** True when the request arrived over HTTPS (session cookie gets Secure). */
  secureCookie: boolean;
  /**
   * Set-Cookie header values queued by handlers (login / logout / edit
   * link redemption). The server layer appends them to the response.
   */
  setCookies: string[];
}

export interface ActionDef<Req, Res> {
  request: z.ZodType<Req>;
  response: z.ZodType<Res>;
  handler: (ctx: Ctx, args: Req) => Promise<Res>;
}

export function defineAction<
  ReqSchema extends z.ZodType,
  ResSchema extends z.ZodType,
>(def: {
  request: ReqSchema;
  response: ResSchema;
  handler: (
    ctx: Ctx,
    args: z.infer<ReqSchema>,
  ) => Promise<z.infer<ResSchema>>;
}): ActionDef<z.infer<ReqSchema>, z.infer<ResSchema>> {
  // The cast bridges zod v4's internal-generics variance; at runtime the
  // definition object is returned unchanged.
  return def as unknown as ActionDef<z.infer<ReqSchema>, z.infer<ResSchema>>;
}

/** A module of actions: a record of action name -> action definition. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionsModule = Record<string, ActionDef<any, any>>;
