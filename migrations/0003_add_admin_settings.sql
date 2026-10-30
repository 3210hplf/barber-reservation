-- D1: add the admin_settings table (single row, id = 1) holding the
-- whole-app admin password as a salted PBKDF2 hash in the same
-- `pbkdf2$<iterations>$<salt>$<hash>` format used for owner PINs.
-- Mirrors drizzle/0005_add_admin_settings.sql for the Bun-local database.
-- An empty password_hash with is_set = 0 means the admin password has not
-- been set up yet; there is no known default password.
CREATE TABLE admin_settings (
  id INTEGER PRIMARY KEY,
  password_hash TEXT NOT NULL DEFAULT '',
  is_set INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT OR IGNORE INTO admin_settings (id, password_hash, is_set) VALUES (1, '', 0);
