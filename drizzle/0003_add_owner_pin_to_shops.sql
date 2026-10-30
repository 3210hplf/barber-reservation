ALTER TABLE shops ADD COLUMN owner_pin TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE shops ADD COLUMN pin_changed INTEGER NOT NULL DEFAULT 0;
