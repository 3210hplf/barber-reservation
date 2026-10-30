ALTER TABLE shops ADD COLUMN slug TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE shops SET slug = 'shop1' WHERE id = (SELECT id FROM shops ORDER BY id ASC LIMIT 1 OFFSET 0);
--> statement-breakpoint
UPDATE shops SET slug = 'shop2' WHERE id = (SELECT id FROM shops ORDER BY id ASC LIMIT 1 OFFSET 1);
--> statement-breakpoint
UPDATE shops SET slug = 'shop' || id WHERE slug = '';
--> statement-breakpoint
CREATE UNIQUE INDEX shops_slug_unique ON shops (slug);
