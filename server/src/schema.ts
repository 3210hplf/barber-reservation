import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const shops = sqliteTable("shops", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // URL用スラッグ（英小文字・数字・ハイフン）。お客さん用 /<slug>、
  // 店主用 /<slug>/owner のパスに使う。店舗ごとに一意。
  slug: text("slug").notNull().default(""),
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
  // 店主画面用の暗証番号。平文では保存せず、ソルト付きハッシュ
  // （pbkdf2$反復回数$salt$hash）で保存する。空文字 = 未設定
  // （初回に店主がその場で決める。既知の初期番号は置かない）
  ownerPin: text("owner_pin").notNull().default(""),
  // 0 = 暗証番号が未設定, 1 = 店主が設定済み
  pinChanged: integer("pin_changed").notNull().default(0),
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
