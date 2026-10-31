-- 営業日カレンダー特化サービスへの作り替え。
-- 予約機能を廃止し、shops を「カレンダー（アカウント）」として転用する。
-- 個人情報（お客さんの氏名・電話番号）を持つ bookings はテーブルごと削除。
DROP TABLE IF EXISTS bookings;
--> statement-breakpoint
DROP TABLE IF EXISTS menus;
--> statement-breakpoint
ALTER TABLE shops DROP COLUMN owner_pin;
--> statement-breakpoint
ALTER TABLE shops DROP COLUMN pin_changed;
--> statement-breakpoint
ALTER TABLE shops DROP COLUMN slot_minutes;
--> statement-breakpoint
ALTER TABLE shops DROP COLUMN chairs;
--> statement-breakpoint
ALTER TABLE shops ADD COLUMN password_hash TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE shops ADD COLUMN message TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE shops ADD COLUMN theme TEXT NOT NULL DEFAULT 'standard';
--> statement-breakpoint
ALTER TABLE shops ADD COLUMN instagram_url TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE shops ADD COLUMN edit_token_hash TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE shops ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE shops ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE shops ADD COLUMN login_locked_until INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL,
  shop_id INTEGER NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX sessions_token_hash_idx ON sessions (token_hash);
--> statement-breakpoint
ALTER TABLE day_overrides ADD COLUMN note TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE day_overrides ADD COLUMN hours TEXT NOT NULL DEFAULT '';
