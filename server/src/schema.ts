import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const shops = sqliteTable("shops", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  address: text("address").notNull().default(""),
  phone: text("phone").notNull().default(""),
  openTime: text("open_time").notNull().default("09:00"),
  closeTime: text("close_time").notNull().default("19:00"),
  slotMinutes: integer("slot_minutes").notNull().default(30),
  chairs: integer("chairs").notNull().default(1),
  // JSON array of weekday numbers (0=Sun..6=Sat) closed every week
  closedWeekdays: text("closed_weekdays").notNull().default("[]"),
  // JSON array of {nth: number, weekday: number} e.g. 2nd Tuesday
  nthClosures: text("nth_closures").notNull().default("[]"),
});

export const dayOverrides = sqliteTable("day_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopId: integer("shop_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  kind: text("kind", { enum: ["closed", "open"] }).notNull(),
});

export const menus = sqliteTable("menus", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopId: integer("shop_id").notNull(),
  name: text("name").notNull(),
  price: integer("price"), // null = 未設定
  minutes: integer("minutes").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const bookings = sqliteTable("bookings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopId: integer("shop_id").notNull(),
  menuId: integer("menu_id"),
  menuName: text("menu_name").notNull(),
  customerName: text("customer_name").notNull(),
  phone: text("phone").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  startTime: text("start_time").notNull(), // HH:MM
  minutes: integer("minutes").notNull(),
  status: text("status", { enum: ["booked", "cancelled"] })
    .notNull()
    .default("booked"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
