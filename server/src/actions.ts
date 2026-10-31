import { defineAction, z, type ActionsModule, type Ctx } from "./framework";
import { asc, eq } from "drizzle-orm";
import * as schema from "./schema";

// ---------- helpers ----------

function todayJST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

function parseWeekdays(json: string): number[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

type NthClosure = { nth: number; weekday: number };

function parseNth(json: string): NthClosure[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is NthClosure =>
        typeof x === "object" && x !== null &&
        typeof (x as NthClosure).nth === "number" &&
        typeof (x as NthClosure).weekday === "number",
    );
  } catch {
    return [];
  }
}

type ShopRow = typeof schema.shops.$inferSelect;

// ---------- password hashing (PBKDF2) ----------
//
// Passwords are never stored in plaintext. They are stored as
// `pbkdf2$<iterations>$<salt base64>$<hash base64>` (PBKDF2-HMAC-SHA-256
// with a per-account random salt). Web Crypto (crypto.subtle) is
// available in both Bun and Cloudflare Workers, so the same code path
// runs in both environments. An empty stored hash means "no password
// set" (login impossible). There is no known default password anywhere.

const PASSWORD_ITERATIONS = 120000;

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt.slice().buffer as ArrayBuffer,
      iterations,
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function hashSecret(secret: string, iterations: number = PASSWORD_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(secret, salt, iterations);
  return `pbkdf2$${iterations}$${toB64(salt)}$${toB64(hash)}`;
}

async function verifySecret(stored: string, secret: string): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let expected: Uint8Array;
  let actual: Uint8Array;
  try {
    expected = fromB64(parts[3] as string);
    actual = await pbkdf2(secret, fromB64(parts[2] as string), iterations);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= (actual[i] as number) ^ (expected[i] as number);
  return diff === 0;
}

// ---------- token hashing (sessions / edit links) ----------
//
// Session tokens and edit-link UUIDs are bearer secrets. Only their
// SHA-256 hash is stored in the database; the plaintext is handed to
// the client exactly once (cookie / one-time display).

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- sessions ----------

export const SESSION_COOKIE_NAME = "cal_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function queueSessionCookie(ctx: Ctx, token: string, maxAgeSeconds: number): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (ctx.secureCookie) parts.push("Secure");
  ctx.setCookies.push(parts.join("; "));
}

async function createSession(
  ctx: Ctx,
  shopId: number,
  scope: "owner" | "editlink",
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const token = randomToken();
  const now = Date.now();
  await db.insert(schema.sessions).values({
    tokenHash: await sha256Hex(token),
    shopId,
    scope,
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
  });
  queueSessionCookie(ctx, token, Math.floor(SESSION_TTL_MS / 1000));
}

type SessionInfo = {
  shop: ShopRow;
  scope: "owner" | "editlink";
};

async function resolveSession(ctx: Ctx): Promise<SessionInfo | null> {
  if (!ctx.sessionToken) return null;
  const db = ctx.db<typeof schema>();
  const tokenHash = await sha256Hex(ctx.sessionToken);
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.tokenHash, tokenHash));
  const session = rows[0];
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, session.id));
    return null;
  }
  const shopRows = await db
    .select()
    .from(schema.shops)
    .where(eq(schema.shops.id, session.shopId));
  const shop = shopRows[0];
  if (!shop) return null;
  return { shop, scope: session.scope };
}

// Editing requires a session (owner login or edit link) for THAT shop.
async function requireShopSession(ctx: Ctx, slug: string): Promise<SessionInfo> {
  const info = await resolveSession(ctx);
  if (!info || info.shop.slug !== slug) {
    throw new Error("編集するにはログイン（または編集リンク）が必要です");
  }
  return info;
}

async function findShopBySlug(ctx: Ctx, slug: string): Promise<ShopRow | undefined> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.shops).where(eq(schema.shops.slug, slug));
  return rows[0];
}

async function touchUpdatedAt(ctx: Ctx, shopId: number): Promise<void> {
  const db = ctx.db<typeof schema>();
  await db
    .update(schema.shops)
    .set({ updatedAt: Date.now() })
    .where(eq(schema.shops.id, shopId));
}

// ---------- slug / theme validation ----------

const RESERVED_SLUGS = new Set([
  "admin", "login", "signup", "api", "actions", "owner", "edit", "logout",
  "help", "about", "terms", "privacy", "support", "www", "mail", "static",
  "public", "index", "home", "new", "register", "account", "settings",
  "calendar", "assets",
]);

const slugSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, "IDは英小文字・数字・ハイフン・アンダースコアで、先頭と末尾は英数字にしてください");

function slugError(slug: string): string | null {
  if (RESERVED_SLUGS.has(slug)) return `「${slug}」はIDに使えません`;
  return null;
}

export const THEMES = ["standard", "warm", "sakura", "forest", "ocean", "mono"] as const;

// ---------- seed (local dev only) ----------
//
// Used by `bun run db:migrate` for local development. The demo accounts
// have NO password and NO edit token, so nobody can log in to them or
// edit them; they exist only so the public calendar can be previewed.
// On Workers/D1 nothing is seeded — accounts are created via signup.

export async function seedIfEmpty(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const existing = await db.select().from(schema.shops).limit(1);
  if (existing.length > 0) return;
  const defaults = [
    { name: "お父さんの店", slug: "shop1" },
    { name: "おじさんの店", slug: "shop2" },
  ];
  for (const d of defaults) {
    await db.insert(schema.shops).values({
      name: d.name,
      slug: d.slug,
      passwordHash: "",
      editTokenHash: "",
      openTime: "09:00",
      closeTime: "19:00",
      closedWeekdays: JSON.stringify([1]),
      nthClosures: JSON.stringify([
        { nth: 2, weekday: 2 },
        { nth: 3, weekday: 2 },
      ]),
      updatedAt: Date.now(),
    });
  }
}

// ---------- shared shapes ----------

// Public shop shape: NEVER includes password_hash / edit_token_hash or
// any other secret column. This is all a visitor of /<slug> may see.
const publicShopShape = z.object({
  slug: z.string(),
  name: z.string(),
  address: z.string(),
  phone: z.string(),
  openTime: z.string(),
  closeTime: z.string(),
  closedWeekdays: z.array(z.number()),
  nthClosures: z.array(z.object({ nth: z.number(), weekday: z.number() })),
  message: z.string(),
  theme: z.string(),
  instagramUrl: z.string(),
  updatedAt: z.string().nullable(), // ISO string, null = never updated
});

type PublicShop = z.infer<typeof publicShopShape>;

function toPublicShop(s: ShopRow): PublicShop {
  return {
    slug: s.slug,
    name: s.name,
    address: s.address,
    phone: s.phone,
    openTime: s.openTime,
    closeTime: s.closeTime,
    closedWeekdays: parseWeekdays(s.closedWeekdays),
    nthClosures: parseNth(s.nthClosures),
    message: s.message,
    theme: s.theme,
    instagramUrl: s.instagramUrl,
    updatedAt: s.updatedAt > 0 ? new Date(s.updatedAt).toISOString() : null,
  };
}

const overrideShape = z.object({
  date: z.string(),
  kind: z.string(),
  note: z.string(),
  hours: z.string(),
});

const resultShape = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
type Result = z.infer<typeof resultShape>;

async function monthOverrides(ctx: Ctx, shopId: number, yearMonth: string) {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.dayOverrides)
    .where(eq(schema.dayOverrides.shopId, shopId))
    .orderBy(asc(schema.dayOverrides.date));
  return rows
    .filter((o) => o.date.startsWith(yearMonth))
    .map((o) => ({ date: o.date, kind: o.kind, note: o.note, hours: o.hours }));
}

// ---------- admin helpers ----------

const ADMIN_PASSWORD_ITERATIONS = 120000;

type AdminRow = typeof schema.adminSettings.$inferSelect;

async function getAdminRow(ctx: Ctx): Promise<AdminRow> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.adminSettings)
    .where(eq(schema.adminSettings.id, 1));
  const row = rows[0];
  if (row) return row;
  await db.insert(schema.adminSettings).values({ id: 1, passwordHash: "", isSet: 0 });
  return { id: 1, passwordHash: "", isSet: 0 };
}

async function verifyAdmin(ctx: Ctx, password: string): Promise<boolean> {
  const row = await getAdminRow(ctx);
  if (row.isSet === 0 || !row.passwordHash) return false;
  return verifySecret(row.passwordHash, password);
}

async function requireAdmin(ctx: Ctx, password: string): Promise<void> {
  const ok = await verifyAdmin(ctx, password);
  if (!ok) throw new Error("管理者認証が必要です。パスワードが違います");
}

// ---------- login throttling ----------

const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000; // 10 minutes

// ---------- actions ----------

export const Actions = {
  // 公開カレンダー: /<slug> 用。認証不要。秘匿列は一切含めない。
  getCalendar: defineAction({
    request: z.object({
      slug: z.string().min(1).max(30),
      yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
    }),
    response: z.object({
      found: z.boolean(),
      shop: publicShopShape.nullable(),
      overrides: z.array(overrideShape),
      today: z.string(),
    }),
    async handler(ctx, args) {
      const shop = await findShopBySlug(ctx, args.slug);
      if (!shop) {
        return { found: false, shop: null, overrides: [], today: todayJST() };
      }
      return {
        found: true,
        shop: toPublicShop(shop),
        overrides: await monthOverrides(ctx, shop.id, args.yearMonth),
        today: todayJST(),
      };
    },
  }),

  // 新規登録: ID（slug）+ パスワードでカレンダーを作成し、そのまま
  // ownerセッションを発行する。編集リンクも同時に発行し、平文は
  // この応答で一度だけ返す（DBにはハッシュのみ）。
  signup: defineAction({
    request: z.object({
      slug: slugSchema,
      name: z.string().min(1).max(50),
      password: z.string().min(8).max(128),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      slug: z.string().nullable(),
      editToken: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const fail = (error: string) => ({ ok: false, error, slug: null, editToken: null });
      const reserved = slugError(args.slug);
      if (reserved) return fail(reserved);
      const db = ctx.db<typeof schema>();
      const existing = await findShopBySlug(ctx, args.slug);
      if (existing) return fail(`ID「${args.slug}」はすでに使われています`);
      const editToken = crypto.randomUUID();
      const inserted = await db
        .insert(schema.shops)
        .values({
          slug: args.slug,
          name: args.name.trim(),
          passwordHash: await hashSecret(args.password),
          editTokenHash: await sha256Hex(editToken),
          openTime: "09:00",
          closeTime: "19:00",
          closedWeekdays: JSON.stringify([1]),
          nthClosures: JSON.stringify([
            { nth: 2, weekday: 2 },
            { nth: 3, weekday: 2 },
          ]),
          updatedAt: Date.now(),
        })
        .returning({ id: schema.shops.id });
      const row = inserted[0];
      if (!row) return fail("登録に失敗しました");
      await createSession(ctx, row.id, "owner");
      ctx.invalidateQueries();
      return { ok: true, error: null, slug: args.slug, editToken };
    },
  }),

  // ログイン: ID + パスワード。失敗が続くとアカウント単位で一定時間
  // ロックする（失敗回数とロック期限はDBに記録）。
  login: defineAction({
    request: z.object({
      slug: slugSchema,
      password: z.string().min(1).max(128),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      slug: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const fail = (error: string) => ({ ok: false, error, slug: null });
      const db = ctx.db<typeof schema>();
      const shop = await findShopBySlug(ctx, args.slug);
      // IDの有無やパスワード未設定を区別せず、同じ文言で返す
      if (!shop || !shop.passwordHash) return fail("IDまたはパスワードが違います");
      const now = Date.now();
      if (shop.loginLockedUntil > now) {
        return fail("ログイン失敗が続いたため、しばらく時間をおいてからお試しください");
      }
      const ok = await verifySecret(shop.passwordHash, args.password);
      if (!ok) {
        const count = shop.failedLoginCount + 1;
        if (count >= LOGIN_MAX_FAILURES) {
          await db
            .update(schema.shops)
            .set({ failedLoginCount: 0, loginLockedUntil: now + LOGIN_LOCK_MS })
            .where(eq(schema.shops.id, shop.id));
          return fail("ログイン失敗が続いたため、しばらく時間をおいてからお試しください");
        }
        await db
          .update(schema.shops)
          .set({ failedLoginCount: count })
          .where(eq(schema.shops.id, shop.id));
        return fail("IDまたはパスワードが違います");
      }
      await db
        .update(schema.shops)
        .set({ failedLoginCount: 0, loginLockedUntil: 0 })
        .where(eq(schema.shops.id, shop.id));
      await createSession(ctx, shop.id, "owner");
      ctx.invalidateQueries();
      return { ok: true, error: null, slug: shop.slug };
    },
  }),

  logout: defineAction({
    request: z.object({}),
    response: resultShape,
    async handler(ctx): Promise<Result> {
      if (ctx.sessionToken) {
        const db = ctx.db<typeof schema>();
        const tokenHash = await sha256Hex(ctx.sessionToken);
        await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
      }
      queueSessionCookie(ctx, "", 0);
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  getSession: defineAction({
    request: z.object({}),
    response: z.object({
      loggedIn: z.boolean(),
      slug: z.string().nullable(),
      scope: z.string().nullable(),
    }),
    async handler(ctx) {
      const info = await resolveSession(ctx);
      if (!info) return { loggedIn: false, slug: null, scope: null };
      return { loggedIn: true, slug: info.shop.slug, scope: info.scope };
    },
  }),

  // 秘密編集リンク /<slug>/<UUID> の照合。合えば、そのカレンダー限定の
  // 編集セッション（scope=editlink）を発行する。
  redeemEditLink: defineAction({
    request: z.object({
      slug: z.string().min(1).max(30),
      token: z.string().min(1).max(100),
    }),
    response: resultShape,
    async handler(ctx, args): Promise<Result> {
      const shop = await findShopBySlug(ctx, args.slug);
      if (!shop || !shop.editTokenHash) {
        return { ok: false, error: "この編集リンクは無効です" };
      }
      const tokenHash = await sha256Hex(args.token);
      if (!hashesEqual(tokenHash, shop.editTokenHash)) {
        return { ok: false, error: "この編集リンクは無効です" };
      }
      await createSession(ctx, shop.id, "editlink");
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 編集画面用: 自分のカレンダーの全情報（秘匿列は含めず、設定済みか
  // どうかのフラグだけを返す）
  getEditState: defineAction({
    request: z.object({
      slug: z.string().min(1).max(30),
      yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
    }),
    response: z.object({
      shop: publicShopShape.extend({
        address: z.string(),
        hasPassword: z.boolean(),
        editTokenSet: z.boolean(),
      }),
      overrides: z.array(overrideShape),
      scope: z.string(),
      today: z.string(),
    }),
    async handler(ctx, args) {
      const info = await requireShopSession(ctx, args.slug);
      const s = info.shop;
      return {
        shop: {
          ...toPublicShop(s),
          hasPassword: s.passwordHash !== "",
          editTokenSet: s.editTokenHash !== "",
        },
        overrides: await monthOverrides(ctx, s.id, args.yearMonth),
        scope: info.scope,
        today: todayJST(),
      };
    },
  }),

  // プロフィール・一言・テーマ・営業時間・定休日ルールの更新
  updateProfile: defineAction({
    request: z.object({
      slug: z.string().min(1).max(30),
      name: z.string().min(1).max(50),
      address: z.string().max(200),
      phone: z.string().max(20),
      openTime: z.string().regex(/^\d{2}:\d{2}$/),
      closeTime: z.string().regex(/^\d{2}:\d{2}$/),
      closedWeekdays: z.array(z.number().int().min(0).max(6)),
      nthClosures: z.array(
        z.object({
          nth: z.number().int().min(1).max(5),
          weekday: z.number().int().min(0).max(6),
        }),
      ),
      message: z.string().max(500),
      theme: z.enum(THEMES),
      instagramUrl: z.string().max(300),
    }),
    response: resultShape,
    async handler(ctx, args): Promise<Result> {
      const info = await requireShopSession(ctx, args.slug);
      const instagramUrl = args.instagramUrl.trim();
      if (instagramUrl !== "" && !instagramUrl.startsWith("https://")) {
        return { ok: false, error: "InstagramのURLは https:// から始まる形で入力してください" };
      }
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.shops)
        .set({
          name: args.name.trim(),
          address: args.address.trim(),
          phone: args.phone.trim(),
          openTime: args.openTime,
          closeTime: args.closeTime,
          closedWeekdays: JSON.stringify(args.closedWeekdays),
          nthClosures: JSON.stringify(args.nthClosures),
          message: args.message,
          theme: args.theme,
          instagramUrl,
          updatedAt: Date.now(),
        })
        .where(eq(schema.shops.id, info.shop.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 日ごとの営業/休業の切替とメモ・時間上書き。kind=clear で上書き解除
  setDayOverride: defineAction({
    request: z.object({
      slug: z.string().min(1).max(30),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      kind: z.enum(["closed", "open", "clear"]),
      note: z.string().max(100),
      hours: z.string().regex(/^(\d{2}:\d{2}-\d{2}:\d{2})?$/),
    }),
    response: resultShape,
    async handler(ctx, args): Promise<Result> {
      const info = await requireShopSession(ctx, args.slug);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.dayOverrides)
        .where(eq(schema.dayOverrides.shopId, info.shop.id));
      const existing = rows.find((o) => o.date === args.date);
      if (args.kind === "clear") {
        if (existing) {
          await db.delete(schema.dayOverrides).where(eq(schema.dayOverrides.id, existing.id));
        }
      } else if (existing) {
        await db
          .update(schema.dayOverrides)
          .set({ kind: args.kind, note: args.note, hours: args.hours })
          .where(eq(schema.dayOverrides.id, existing.id));
      } else {
        await db.insert(schema.dayOverrides).values({
          shopId: info.shop.id,
          date: args.date,
          kind: args.kind,
          note: args.note,
          hours: args.hours,
        });
      }
      await touchUpdatedAt(ctx, info.shop.id);
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // パスワード変更: 現在のパスワードの照合が必須（編集リンクだけでは
  // 変更できない）。変更したら他のセッションは全て破棄する
  changePassword: defineAction({
    request: z.object({
      slug: z.string().min(1).max(30),
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(8).max(128),
    }),
    response: resultShape,
    async handler(ctx, args): Promise<Result> {
      const info = await requireShopSession(ctx, args.slug);
      const shop = info.shop;
      if (!shop.passwordHash) {
        return { ok: false, error: "パスワードが設定されていません" };
      }
      if (!(await verifySecret(shop.passwordHash, args.currentPassword))) {
        return { ok: false, error: "今のパスワードが違います" };
      }
      if (args.newPassword === args.currentPassword) {
        return { ok: false, error: "新しいパスワードが今と同じです" };
      }
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.shops)
        .set({
          passwordHash: await hashSecret(args.newPassword),
          failedLoginCount: 0,
          loginLockedUntil: 0,
        })
        .where(eq(schema.shops.id, shop.id));
      // 他のセッションを破棄（現在のセッションだけ残す）
      const allSessions = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.shopId, shop.id));
      const currentHash = ctx.sessionToken ? await sha256Hex(ctx.sessionToken) : "";
      for (const s of allSessions) {
        if (s.tokenHash !== currentHash) {
          await db.delete(schema.sessions).where(eq(schema.sessions.id, s.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 編集リンクの再発行: 新しいUUIDを発行し、旧リンクは無効化する。
  // 平文はこの応答で一度だけ返す
  reissueEditToken: defineAction({
    request: z.object({ slug: z.string().min(1).max(30) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      editToken: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const info = await requireShopSession(ctx, args.slug);
      const editToken = crypto.randomUUID();
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.shops)
        .set({ editTokenHash: await sha256Hex(editToken) })
        .where(eq(schema.shops.id, info.shop.id));
      ctx.invalidateQueries();
      return { ok: true, error: null, editToken };
    },
  }),

  // ---------- admin (全体管理・運営用) ----------
  // /admin ページ専用。管理者パスワードは既知の初期値を置かず、未設定の
  // 間だけ最初に開いた管理者本人が設定できる。機能はアカウント一覧と
  // アカウント削除に絞る（店舗追加はセルフ登録に置き換えた）。

  getAdminStatus: defineAction({
    request: z.object({}),
    response: z.object({ needsSetup: z.boolean() }),
    async handler(ctx): Promise<{ needsSetup: boolean }> {
      const row = await getAdminRow(ctx);
      return { needsSetup: row.isSet === 0 };
    },
  }),

  setupAdminPassword: defineAction({
    request: z.object({
      newPassword: z.string().min(6).max(128),
    }),
    response: resultShape,
    async handler(ctx, args): Promise<Result> {
      const row = await getAdminRow(ctx);
      if (row.isSet !== 0) {
        return { ok: false, error: "すでに管理者パスワードが設定されています" };
      }
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.adminSettings)
        .set({
          passwordHash: await hashSecret(args.newPassword, ADMIN_PASSWORD_ITERATIONS),
          isSet: 1,
        })
        .where(eq(schema.adminSettings.id, 1));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  verifyAdminPassword: defineAction({
    request: z.object({ password: z.string().min(1).max(128) }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: boolean }> {
      const ok = await verifyAdmin(ctx, args.password);
      return { ok };
    },
  }),

  changeAdminPassword: defineAction({
    request: z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(6).max(128),
    }),
    response: resultShape,
    async handler(ctx, args): Promise<Result> {
      const row = await getAdminRow(ctx);
      if (row.isSet === 0) {
        return { ok: false, error: "管理者パスワードがまだ設定されていません" };
      }
      const ok = await verifyAdmin(ctx, args.currentPassword);
      if (!ok) return { ok: false, error: "今のパスワードが違います" };
      if (args.newPassword === args.currentPassword) {
        return { ok: false, error: "新しいパスワードが今と同じです" };
      }
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.adminSettings)
        .set({
          passwordHash: await hashSecret(args.newPassword, ADMIN_PASSWORD_ITERATIONS),
          isSet: 1,
        })
        .where(eq(schema.adminSettings.id, 1));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 管理者専用: 全アカウントの一覧（秘匿列は含めない）
  adminListAccounts: defineAction({
    request: z.object({ adminPassword: z.string().min(1).max(128) }),
    response: z.object({
      accounts: z.array(
        z.object({
          id: z.number(),
          slug: z.string(),
          name: z.string(),
          hasPassword: z.boolean(),
          editTokenSet: z.boolean(),
          updatedAt: z.string().nullable(),
        }),
      ),
    }),
    async handler(ctx, args) {
      await requireAdmin(ctx, args.adminPassword);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.shops).orderBy(asc(schema.shops.id));
      return {
        accounts: rows.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          hasPassword: s.passwordHash !== "",
          editTokenSet: s.editTokenHash !== "",
          updatedAt: s.updatedAt > 0 ? new Date(s.updatedAt).toISOString() : null,
        })),
      };
    },
  }),

  // 管理者専用: アカウントの削除（カレンダー・上書き・セッションを全て消す）
  adminDeleteAccount: defineAction({
    request: z.object({
      adminPassword: z.string().min(1).max(128),
      shopId: z.number().int(),
    }),
    response: resultShape,
    async handler(ctx, args): Promise<Result> {
      try {
        await requireAdmin(ctx, args.adminPassword);
      } catch {
        return { ok: false, error: "管理者認証が必要です。パスワードが違います" };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.shops).where(eq(schema.shops.id, args.shopId));
      if (!rows[0]) return { ok: false, error: "アカウントが見つかりません" };
      await db.delete(schema.dayOverrides).where(eq(schema.dayOverrides.shopId, args.shopId));
      await db.delete(schema.sessions).where(eq(schema.sessions.shopId, args.shopId));
      await db.delete(schema.shops).where(eq(schema.shops.id, args.shopId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),
} satisfies ActionsModule;
