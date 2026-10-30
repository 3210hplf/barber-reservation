CREATE TABLE admin_settings (
  id INTEGER PRIMARY KEY,
  password_hash TEXT NOT NULL DEFAULT '',
  is_set INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT OR IGNORE INTO admin_settings (id, password_hash, is_set) VALUES (1, '', 0);
