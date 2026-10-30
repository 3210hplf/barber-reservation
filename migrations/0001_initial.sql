-- D1 (Cloudflare) initial schema for a fresh database.
-- Mirrors the Bun-local Drizzle migrations (drizzle/0002 + drizzle/0003),
-- including the owner-PIN columns. Initial data (2 shops + default menus)
-- is inserted lazily by the app itself (seedIfEmpty in the getState action),
-- so no seed SQL is needed here.
CREATE TABLE shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  open_time TEXT NOT NULL DEFAULT '09:00',
  close_time TEXT NOT NULL DEFAULT '19:00',
  slot_minutes INTEGER NOT NULL DEFAULT 30,
  chairs INTEGER NOT NULL DEFAULT 1,
  closed_weekdays TEXT NOT NULL DEFAULT '[]',
  nth_closures TEXT NOT NULL DEFAULT '[]',
  owner_pin TEXT NOT NULL DEFAULT '',
  pin_changed INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE day_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE menus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price INTEGER,
  minutes INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  menu_id INTEGER,
  menu_name TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked',
  created_at INTEGER NOT NULL
);
