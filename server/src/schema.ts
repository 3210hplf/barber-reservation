import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 「カレンダー」= 1つのアカウント（お店）。ID（slug）がそのまま公開パス
// /<slug> になり、誰でもカレンダーを閲覧できる。個人情報（お客さんの
// 氏名・電話番号）はこのサービスでは一切扱わない。
export const shops = sqliteTable("shops", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // アカウントID = 公開パス /<slug>。英小文字・数字・ハイフン・
  // アンダースコア、3〜30字。アカウントごとに一意（UNIQUE INDEX）。
  slug: text("slug").notNull().default(""),
  name: text("name").notNull(),
  address: text("address").notNull().default(""),
  // お店自身の連絡先（公開ページに表示する店舗情報。お客さんの個人
  // 情報ではない）
  phone: text("phone").notNull().default(""),
  openTime: text("open_time").notNull().default("09:00"),
  closeTime: text("close_time").notNull().default("19:00"),
  // JSON array of weekday numbers (0=Sun..6=Sat) closed every week
  closedWeekdays: text("closed_weekdays").notNull().default("[]"),
  // JSON array of {nth: number, weekday: number} e.g. 2nd Tuesday
  nthClosures: text("nth_closures").notNull().default("[]"),
  // ログインパスワード。平文では保存せず、ソルト付きハッシュ
  // （pbkdf2$反復回数$salt$hash）で保存する。空文字 = 未設定
  // （セルフ登録していないデモ用アカウント等はログイン不可）
  passwordHash: text("password_hash").notNull().default(""),
  // 店主の一言（公開カレンダーに表示）
  message: text("message").notNull().default(""),
  // カレンダーのテーマ（プリセット名。例: standard / warm / sakura ...）
  theme: text("theme").notNull().default("standard"),
  // 公式Instagram等のURL（任意、公開ページからリンク）
  instagramUrl: text("instagram_url").notNull().default(""),
  // 秘密編集リンク /<slug>/<UUID> のUUIDのハッシュ（SHA-256 hex）のみを
  // 保存する。平文のトークンは発行時に一度だけ返す。空文字 = 未発行
  editTokenHash: text("edit_token_hash").notNull().default(""),
  // カレンダーの最終更新日時（epoch ms）。公開ページに表示する
  updatedAt: integer("updated_at").notNull().default(0),
  // ログインの簡易スロットリング用（アカウント単位）
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  loginLockedUntil: integer("login_locked_until").notNull().default(0),
});

// ログイン／編集リンクのセッション。cookie には平文トークンを入れ、
// DBにはその SHA-256 ハッシュだけを保存する。
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull(),
  shopId: integer("shop_id").notNull(),
  // owner = ID+パスワードのログイン, editlink = 秘密編集リンク経由
  scope: text("scope", { enum: ["owner", "editlink"] }).notNull(),
  expiresAt: integer("expires_at").notNull(), // epoch ms
  createdAt: integer("created_at").notNull(), // epoch ms
});

// 全体管理（admin）の設定。常に行は1つだけ（id = 1）。
export const adminSettings = sqliteTable("admin_settings", {
  id: integer("id").primaryKey(),
  // 管理者パスワード。平文では保存せず、ソルト付きハッシュ
  // （pbkdf2$反復回数$salt$hash）で保存する。空文字 = 未設定
  // （初回に管理者本人がその場で決める。既知の初期パスワードは置かない）
  passwordHash: text("password_hash").notNull().default(""),
  // 0 = 管理者パスワードが未設定, 1 = 管理者が設定済み
  isSet: integer("is_set").notNull().default(0),
});

// 日ごとの営業/休業の上書き（定休日ルールより優先）
export const dayOverrides = sqliteTable("day_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shopId: integer("shop_id").notNull(),
  date: text("date").notNull(), // YYYY-MM-DD
  kind: text("kind", { enum: ["closed", "open"] }).notNull(),
  // その日だけのメモ（例: 「午後から営業」）。公開カレンダーに表示
  note: text("note").notNull().default(""),
  // その日だけの営業時間上書き（"HH:MM-HH:MM"、空文字 = 通常の営業時間）
  hours: text("hours").notNull().default(""),
});
