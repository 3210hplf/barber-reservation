// SQLite connection (Bun's built-in sqlite + Drizzle) and migrations.

import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Ctx } from "./framework";
import * as schema from "./schema";

const repoRoot = path.join(import.meta.dir, "..", "..");

/**
 * Database file location. Defaults to `data/barber.db` in the repo root;
 * override with the DATABASE_PATH environment variable.
 */
export const databasePath =
  process.env.DATABASE_PATH ?? path.join(repoRoot, "data", "barber.db");

mkdirSync(path.dirname(databasePath), { recursive: true });

const sqlite = new Database(databasePath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle(sqlite, { schema });

/** Apply all pending migrations from the repo's `drizzle/` folder. */
export function runMigrations(): void {
  migrate(db, { migrationsFolder: path.join(repoRoot, "drizzle") });
}

/** Build the per-request Ctx object passed to action handlers. */
export function createCtx(
  opts: { sessionToken?: string | null; secureCookie?: boolean } = {},
): Ctx {
  return {
    db: <TSchema extends Record<string, unknown>>() =>
      db as unknown as BunSQLiteDatabase<TSchema>,
    invalidateQueries: () => {
      // No-op locally: the web client invalidates its own queries.
    },
    sessionToken: opts.sessionToken ?? null,
    secureCookie: opts.secureCookie ?? false,
    setCookies: [],
  };
}
