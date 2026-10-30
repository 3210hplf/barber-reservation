-- D1: add the per-shop URL slug (customer page /<slug>, owner page
-- /<slug>/owner). Mirrors drizzle/0004_add_slug_to_shops.sql for the
-- Bun-local database: existing shops are backfilled shop1 / shop2 in
-- id order (any further shops get 'shop' || id), then a unique index
-- keeps slugs unique.
ALTER TABLE shops ADD COLUMN slug TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE shops SET slug = 'shop1' WHERE id = (SELECT id FROM shops ORDER BY id ASC LIMIT 1 OFFSET 0);
--> statement-breakpoint
UPDATE shops SET slug = 'shop2' WHERE id = (SELECT id FROM shops ORDER BY id ASC LIMIT 1 OFFSET 1);
--> statement-breakpoint
UPDATE shops SET slug = 'shop' || id WHERE slug = '';
--> statement-breakpoint
CREATE UNIQUE INDEX shops_slug_unique ON shops (slug);
