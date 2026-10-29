// `bun run db:migrate` — apply migrations, then insert the initial data
// (2 shops + default menus) if the shops table is still empty.
//
// Safe to run repeatedly: migrations are tracked by Drizzle and the seed
// step does nothing once any shop exists.

import { seedIfEmpty } from "./actions";
import { createCtx, databasePath, runMigrations } from "./db";

runMigrations();
console.log(`migrations applied (db: ${databasePath})`);

await seedIfEmpty(createCtx());
console.log("initial data checked (seeded only when empty)");
