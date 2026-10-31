// `bun run db:migrate` — apply migrations, then insert the local-dev
// demo data (2 password-less demo calendars) if the shops table is
// still empty. The demo accounts have no password and no edit token,
// so they cannot be logged into or edited; they only let the public
// calendar be previewed locally. Production (Workers/D1) starts empty
// and accounts are created through signup instead.
//
// Safe to run repeatedly: migrations are tracked by Drizzle and the
// seed step does nothing once any shop exists.

import { seedIfEmpty } from "./actions";
import { createCtx, databasePath, runMigrations } from "./db";

runMigrations();
console.log(`migrations applied (db: ${databasePath})`);

await seedIfEmpty(createCtx());
console.log("demo data checked (seeded only when empty)");
