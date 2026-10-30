import { defineAction, z, type ActionsModule, type Ctx } from "./framework";
import { asc, eq } from "drizzle-orm";
import * as schema from "./schema";

// ---------- helpers ----------

function toMin(t: string): number {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return h * 60 + m;
}

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
type OverrideRow = typeof schema.dayOverrides.$inferSelect;

function isOpenDay(shop: ShopRow, overrides: OverrideRow[], date: string): boolean {
  const ov = overrides.find((o) => o.shopId === shop.id && o.date === date);
  if (ov) return ov.kind === "open";
  const d = new Date(`${date}T00:00:00`);
  const weekday = d.getDay();
  if (parseWeekdays(shop.closedWeekdays).includes(weekday)) return false;
  const nth = Math.ceil(d.getDate() / 7);
  if (parseNth(shop.nthClosures).some((c) => c.nth === nth && c.weekday === weekday)) return false;
  return true;
}

function digits(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

// ---------- owner PIN hashing ----------
//
// Owner PINs are never stored in plaintext. They are stored in the
// owner_pin column as `pbkdf2$<iterations>$<salt base64>$<hash base64>`
// (PBKDF2-HMAC-SHA-256 with a per-shop random salt). Web Crypto
// (crypto.subtle) is available in both Bun and Cloudflare Workers, so the
// same code path runs in both environments. An empty owner_pin means the
// PIN has not been set up yet.

const PIN_ITERATIONS = 10000;

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

async function pbkdf2(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      // Hand deriveBits an exact-size copy of the salt buffer (the salt
      // arrays used here are always freshly allocated, never views).
      salt: salt.slice().buffer as ArrayBuffer,
      iterations,
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

// Hashes a secret into the `pbkdf2$<iterations>$<salt>$<hash>` storage
// format. Used for owner PINs (PIN_ITERATIONS) and for the admin password
// (ADMIN_PASSWORD_ITERATIONS, defined with the admin helpers below).
// verifyPin() below reads the iteration count back out of the stored
// string, so it verifies either kind of secret unchanged.
async function hashPin(pin: string, iterations: number = PIN_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pin, salt, iterations);
  return `pbkdf2$${iterations}$${toB64(salt)}$${toB64(hash)}`;
}

async function verifyPin(stored: string, pin: string): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let expected: Uint8Array;
  let actual: Uint8Array;
  try {
    expected = fromB64(parts[3] as string);
    actual = await pbkdf2(pin, fromB64(parts[2] as string), iterations);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= (actual[i] as number) ^ (expected[i] as number);
  return diff === 0;
}

const DEFAULT_MENUS: { name: string; price: number; minutes: number }[] = [
  { name: "カット", price: 4000, minutes: 60 },
  { name: "カット＋顔剃り", price: 4500, minutes: 60 },
  { name: "カット＋シャンプー", price: 4500, minutes: 60 },
  { name: "顔剃り", price: 1500, minutes: 30 },
  { name: "カラー（白髪染め）", price: 6000, minutes: 90 },
  { name: "パーマ", price: 8000, minutes: 120 },
];

export async function seedIfEmpty(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const existing = await db.select().from(schema.shops).limit(1);
  if (existing.length > 0) return;
  const defaults = [
    { name: "お父さんの店", slug: "shop1" },
    { name: "おじさんの店", slug: "shop2" },
  ];
  for (const d of defaults) {
    const inserted = await db
      .insert(schema.shops)
      .values({
        name: d.name,
        slug: d.slug,
        ownerPin: "",
        pinChanged: 0,
        openTime: "09:00",
        closeTime: "19:00",
        slotMinutes: 30,
        chairs: 1,
        closedWeekdays: JSON.stringify([1]),
        nthClosures: JSON.stringify([
          { nth: 2, weekday: 2 },
          { nth: 3, weekday: 2 },
        ]),
      })
      .returning({ id: schema.shops.id });
    const shop = inserted[0];
    if (!shop) continue;
    for (let i = 0; i < DEFAULT_MENUS.length; i++) {
      const m = DEFAULT_MENUS[i];
      if (!m) continue;
      await db.insert(schema.menus).values({
        shopId: shop.id,
        name: m.name,
        price: m.price,
        minutes: m.minutes,
        sortOrder: i,
      });
    }
  }
}

// ---------- shared shapes ----------

const shopShape = z.object({
  id: z.number(),
  slug: z.string(),
  name: z.string(),
  address: z.string(),
  phone: z.string(),
  openTime: z.string(),
  closeTime: z.string(),
  slotMinutes: z.number(),
  chairs: z.number(),
  closedWeekdays: z.array(z.number()),
  nthClosures: z.array(z.object({ nth: z.number(), weekday: z.number() })),
  // 暗証番号そのものはクライアントへ渡さず、未設定かどうかだけ渡す
  pinNeedsSetup: z.boolean(),
});

async function requireOwnerPin(ctx: Ctx, shopId: number, pin: string): Promise<ShopRow> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.shops).where(eq(schema.shops.id, shopId));
  const shop = rows[0];
  if (!shop) throw new Error("お店が見つかりません");
  if (!(await verifyPin(shop.ownerPin, pin))) throw new Error("暗証番号が違います");
  // 暗証番号が未設定の間は店主操作はできない（初回設定だけが可能）
  if (shop.pinChanged === 0) {
    throw new Error("暗証番号がまだ設定されていません。店主画面の初回設定をしてください");
  }
  return shop;
}

const pinResultShape = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
type PinResult = z.infer<typeof pinResultShape>;

// ---------- admin (全体管理) ----------
//
// The admin password is stored exactly like owner PINs (salted PBKDF2 in
// the `pbkdf2$<iterations>$<salt>$<hash>` format, constant-time compare
// via verifyPin), just with more iterations. Plaintext is never stored
// and there is no known default password: while unset, only the first
// person to open /admin can set it (setupAdminPassword refuses once set).

const ADMIN_PASSWORD_ITERATIONS = 120000;

// Slugs that can never be assigned to a shop: "owner" is the per-shop
// owner path segment, "admin" is the whole-app admin page path.
const RESERVED_SLUGS = new Set(["owner", "admin"]);

type AdminRow = typeof schema.adminSettings.$inferSelect;

async function getAdminRow(ctx: Ctx): Promise<AdminRow> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.adminSettings)
    .where(eq(schema.adminSettings.id, 1));
  const row = rows[0];
  if (row) return row;
  await db
    .insert(schema.adminSettings)
    .values({ id: 1, passwordHash: "", isSet: 0 });
  return { id: 1, passwordHash: "", isSet: 0 };
}

async function verifyAdmin(ctx: Ctx, password: string): Promise<boolean> {
  const row = await getAdminRow(ctx);
  if (row.isSet === 0 || !row.passwordHash) return false;
  return verifyPin(row.passwordHash, password);
}

async function requireAdmin(ctx: Ctx, password: string): Promise<void> {
  const ok = await verifyAdmin(ctx, password);
  if (!ok) throw new Error("管理者認証が必要です。パスワードが違います");
}

const menuShape = z.object({
  id: z.number(),
  shopId: z.number(),
  name: z.string(),
  price: z.number().nullable(),
  minutes: z.number(),
  sortOrder: z.number(),
});

const bookingShape = z.object({
  id: z.number(),
  shopId: z.number(),
  menuId: z.number().nullable(),
  menuName: z.string(),
  customerName: z.string(),
  phone: z.string(),
  date: z.string(),
  startTime: z.string(),
  minutes: z.number(),
  status: z.string(),
  createdAt: z.string(),
});

// 公開用（暗証番号なしで返す）予約形: 空き状況の計算に必要な項目だけ。
// 氏名・電話番号は含めない。
const publicBookingShape = z.object({
  id: z.number(),
  shopId: z.number(),
  menuId: z.number().nullable(),
  menuName: z.string(),
  date: z.string(),
  startTime: z.string(),
  minutes: z.number(),
  status: z.string(),
  createdAt: z.string(),
});

type BookingRow = typeof schema.bookings.$inferSelect;

function toFullBooking(b: BookingRow): z.infer<typeof bookingShape> {
  return {
    id: b.id,
    shopId: b.shopId,
    menuId: b.menuId,
    menuName: b.menuName,
    customerName: b.customerName,
    phone: b.phone,
    date: b.date,
    startTime: b.startTime,
    minutes: b.minutes,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
  };
}

const okShape = z.object({ ok: z.literal(true) });
type Ok = z.infer<typeof okShape>;

const bookingResultShape = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  bookingId: z.number().nullable(),
});
type BookingResult = z.infer<typeof bookingResultShape>;

export const Actions = {
  getState: defineAction({
    request: z.object({}),
    response: z.object({
      shops: z.array(shopShape),
      menus: z.array(menuShape),
      overrides: z.array(
        z.object({
          id: z.number(),
          shopId: z.number(),
          date: z.string(),
          kind: z.string(),
        }),
      ),
      bookings: z.array(publicBookingShape),
      today: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await seedIfEmpty(ctx);
      const shopRows = await db.select().from(schema.shops).orderBy(asc(schema.shops.id));
      const menuRows = await db.select().from(schema.menus).orderBy(asc(schema.menus.sortOrder), asc(schema.menus.id));
      const overrideRows = await db.select().from(schema.dayOverrides);
      const bookingRows = await db.select().from(schema.bookings).orderBy(asc(schema.bookings.date), asc(schema.bookings.startTime));
      return {
        shops: shopRows.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          address: s.address,
          phone: s.phone,
          openTime: s.openTime,
          closeTime: s.closeTime,
          slotMinutes: s.slotMinutes,
          chairs: s.chairs,
          closedWeekdays: parseWeekdays(s.closedWeekdays),
          nthClosures: parseNth(s.nthClosures),
          pinNeedsSetup: s.pinChanged === 0,
        })),
        menus: menuRows.map((m) => ({
          id: m.id,
          shopId: m.shopId,
          name: m.name,
          price: m.price,
          minutes: m.minutes,
          sortOrder: m.sortOrder,
        })),
        overrides: overrideRows.map((o) => ({
          id: o.id,
          shopId: o.shopId,
          date: o.date,
          kind: o.kind,
        })),
        bookings: bookingRows.map((b) => ({
          id: b.id,
          shopId: b.shopId,
          menuId: b.menuId,
          menuName: b.menuName,
          date: b.date,
          startTime: b.startTime,
          minutes: b.minutes,
          status: b.status,
          createdAt: b.createdAt.toISOString(),
        })),
        today: todayJST(),
      };
    },
  }),

  // 店主専用: 暗証番号認証後に、その店舗の予約（氏名・電話番号つき）を返す
  getOwnerBookings: defineAction({
    request: z.object({
      shopId: z.number().int(),
      ownerPin: z.string().regex(/^\d{4}$/),
    }),
    response: z.object({ bookings: z.array(bookingShape) }),
    async handler(ctx, args): Promise<{ bookings: z.infer<typeof bookingShape>[] }> {
      await requireOwnerPin(ctx, args.shopId, args.ownerPin);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.shopId, args.shopId))
        .orderBy(asc(schema.bookings.date), asc(schema.bookings.startTime));
      return { bookings: rows.map(toFullBooking) };
    },
  }),

  // お客さん専用: 予約時の電話番号で、指定した店舗における自分の今後の
  // 予約だけを返す（店舗専用ページから使うため店舗スコープにする）
  lookupMyBookings: defineAction({
    request: z.object({
      shopId: z.number().int(),
      phone: z.string().min(8).max(20),
    }),
    response: z.object({ bookings: z.array(bookingShape) }),
    async handler(ctx, args): Promise<{ bookings: z.infer<typeof bookingShape>[] }> {
      const db = ctx.db<typeof schema>();
      const target = digits(args.phone);
      const today = todayJST();
      const rows = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.shopId, args.shopId))
        .orderBy(asc(schema.bookings.date), asc(schema.bookings.startTime));
      const mine = rows.filter(
        (b) => digits(b.phone) === target && b.status === "booked" && b.date >= today,
      );
      return { bookings: mine.map(toFullBooking) };
    },
  }),

  createBooking: defineAction({
    request: z.object({
      shopId: z.number().int(),
      menuId: z.number().int(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      startTime: z.string().regex(/^\d{2}:\d{2}$/),
      customerName: z.string().min(1).max(50),
      phone: z.string().min(8).max(20),
    }),
    response: bookingResultShape,
    async handler(ctx, args): Promise<BookingResult> {
      const db = ctx.db<typeof schema>();
      const fail = (error: string): BookingResult => ({ ok: false, error, bookingId: null });

      if (args.date < todayJST()) return fail("過去の日付には予約できません");
      const shopRows = await db.select().from(schema.shops).where(eq(schema.shops.id, args.shopId));
      const shop = shopRows[0];
      if (!shop) return fail("お店が見つかりません");
      const menuRows = await db.select().from(schema.menus).where(eq(schema.menus.id, args.menuId));
      const menu = menuRows[0];
      if (!menu || menu.shopId !== shop.id) return fail("メニューが見つかりません");

      const overrides = await db.select().from(schema.dayOverrides).where(eq(schema.dayOverrides.shopId, shop.id));
      if (!isOpenDay(shop, overrides, args.date)) return fail("その日は休業日です");

      const start = toMin(args.startTime);
      const end = start + menu.minutes;
      if (start < toMin(shop.openTime) || end > toMin(shop.closeTime)) {
        return fail("営業時間内に終わる時間を選んでください");
      }

      const dayBookings = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.shopId, shop.id));
      const active = dayBookings.filter((b) => b.date === args.date && b.status === "booked");
      const points = new Set<number>([start]);
      for (const b of active) {
        const bs = toMin(b.startTime);
        if (bs > start && bs < end) points.add(bs);
      }
      for (const p of points) {
        const covering = active.filter((b) => {
          const bs = toMin(b.startTime);
          const be = bs + b.minutes;
          return bs <= p && p < be;
        }).length;
        if (covering >= shop.chairs) {
          return fail("その時間は満席です。別の時間を選んでください");
        }
      }

      const inserted = await db
        .insert(schema.bookings)
        .values({
          shopId: shop.id,
          menuId: menu.id,
          menuName: menu.name,
          customerName: args.customerName,
          phone: args.phone,
          date: args.date,
          startTime: args.startTime,
          minutes: menu.minutes,
        })
        .returning({ id: schema.bookings.id });
      const row = inserted[0];
      if (!row) return fail("予約に失敗しました");
      ctx.invalidateQueries();
      return { ok: true, error: null, bookingId: row.id };
    },
  }),

  cancelBooking: defineAction({
    request: z.object({
      id: z.number().int(),
      phone: z.string().max(20).optional(),
      ownerPin: z.string().regex(/^\d{4}$/).optional(),
    }),
    response: bookingResultShape,
    async handler(ctx, args): Promise<BookingResult> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.bookings).where(eq(schema.bookings.id, args.id));
      const b = rows[0];
      if (!b) return { ok: false, error: "予約が見つかりません", bookingId: null };
      if (args.phone !== undefined) {
        // お客さん側: 予約時の電話番号で照合
        if (digits(args.phone) !== digits(b.phone)) {
          return { ok: false, error: "電話番号が予約と一致しません", bookingId: null };
        }
      } else if (args.ownerPin !== undefined) {
        // 店主側: その店舗の暗証番号で照合（初期の仮暗証番号のままでは不可）
        const shopRows = await db.select().from(schema.shops).where(eq(schema.shops.id, b.shopId));
        const shop = shopRows[0];
        if (!shop || !(await verifyPin(shop.ownerPin, args.ownerPin))) {
          return { ok: false, error: "暗証番号が違います", bookingId: null };
        }
        if (shop.pinChanged === 0) {
          return { ok: false, error: "暗証番号がまだ設定されていません", bookingId: null };
        }
      } else {
        return { ok: false, error: "認証が必要です", bookingId: null };
      }
      await db
        .update(schema.bookings)
        .set({ status: "cancelled" })
        .where(eq(schema.bookings.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null, bookingId: args.id };
    },
  }),

  verifyOwnerPin: defineAction({
    request: z.object({
      shopId: z.number().int(),
      pin: z.string().regex(/^\d{4}$/),
    }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: boolean }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.shops).where(eq(schema.shops.id, args.shopId));
      const shop = rows[0];
      return { ok: shop !== undefined && (await verifyPin(shop.ownerPin, args.pin)) };
    },
  }),

  // 初回設定: 暗証番号が未設定の店舗にだけ、店主がその場で決めた番号を設定できる。
  // 既知の初期番号は存在しない。設定済みの店舗では使えない。
  setupOwnerPin: defineAction({
    request: z.object({
      shopId: z.number().int(),
      newPin: z.string().regex(/^\d{4}$/),
    }),
    response: pinResultShape,
    async handler(ctx, args): Promise<PinResult> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.shops).where(eq(schema.shops.id, args.shopId));
      const shop = rows[0];
      if (!shop) return { ok: false, error: "お店が見つかりません" };
      if (shop.pinChanged !== 0 || shop.ownerPin !== "") {
        return { ok: false, error: "すでに暗証番号が設定されています" };
      }
      await db
        .update(schema.shops)
        .set({ ownerPin: await hashPin(args.newPin), pinChanged: 1 })
        .where(eq(schema.shops.id, args.shopId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  changeOwnerPin: defineAction({
    request: z.object({
      shopId: z.number().int(),
      currentPin: z.string().regex(/^\d{4}$/),
      newPin: z.string().regex(/^\d{4}$/),
    }),
    response: pinResultShape,
    async handler(ctx, args): Promise<PinResult> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.shops).where(eq(schema.shops.id, args.shopId));
      const shop = rows[0];
      if (!shop) return { ok: false, error: "お店が見つかりません" };
      if (shop.pinChanged === 0 || shop.ownerPin === "") {
        return {
          ok: false,
          error: "暗証番号がまだ設定されていません。店主画面の初回設定から設定してください",
        };
      }
      if (!(await verifyPin(shop.ownerPin, args.currentPin))) {
        return { ok: false, error: "今の暗証番号が違います" };
      }
      if (args.newPin === args.currentPin) {
        return { ok: false, error: "新しい暗証番号が今と同じです" };
      }
      await db
        .update(schema.shops)
        .set({ ownerPin: await hashPin(args.newPin), pinChanged: 1 })
        .where(eq(schema.shops.id, args.shopId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  updateShop: defineAction({
    request: z.object({
      id: z.number().int(),
      ownerPin: z.string().regex(/^\d{4}$/),
      slug: z
        .string()
        .min(2)
        .max(32)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      name: z.string().min(1).max(50),
      address: z.string().max(200),
      phone: z.string().max(20),
      openTime: z.string().regex(/^\d{2}:\d{2}$/),
      closeTime: z.string().regex(/^\d{2}:\d{2}$/),
      slotMinutes: z.number().int().min(10).max(120),
      chairs: z.number().int().min(1).max(10),
      closedWeekdays: z.array(z.number().int().min(0).max(6)),
      nthClosures: z.array(
        z.object({
          nth: z.number().int().min(1).max(5),
          weekday: z.number().int().min(0).max(6),
        }),
      ),
    }),
    response: pinResultShape,
    async handler(ctx, args): Promise<PinResult> {
      await requireOwnerPin(ctx, args.id, args.ownerPin);
      // 「owner」「admin」はパスの予約語なのでスラッグには使えない
      if (RESERVED_SLUGS.has(args.slug)) {
        return { ok: false, error: `「${args.slug}」はURL用スラッグに使えません` };
      }
      const db = ctx.db<typeof schema>();
      const all = await db.select().from(schema.shops);
      const conflict = all.find((s) => s.id !== args.id && s.slug === args.slug);
      if (conflict) {
        return {
          ok: false,
          error: `スラッグ「${args.slug}」は他のお店（${conflict.name}）で使われています`,
        };
      }
      await db
        .update(schema.shops)
        .set({
          slug: args.slug,
          name: args.name,
          address: args.address,
          phone: args.phone,
          openTime: args.openTime,
          closeTime: args.closeTime,
          slotMinutes: args.slotMinutes,
          chairs: args.chairs,
          closedWeekdays: JSON.stringify(args.closedWeekdays),
          nthClosures: JSON.stringify(args.nthClosures),
        })
        .where(eq(schema.shops.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  setDayOverride: defineAction({
    request: z.object({
      shopId: z.number().int(),
      ownerPin: z.string().regex(/^\d{4}$/),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      kind: z.enum(["closed", "open", "clear"]),
    }),
    response: okShape,
    async handler(ctx, args): Promise<Ok> {
      await requireOwnerPin(ctx, args.shopId, args.ownerPin);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.dayOverrides).where(eq(schema.dayOverrides.shopId, args.shopId));
      const existing = rows.find((o) => o.date === args.date);
      if (args.kind === "clear") {
        if (existing) {
          await db.delete(schema.dayOverrides).where(eq(schema.dayOverrides.id, existing.id));
        }
      } else if (existing) {
        await db
          .update(schema.dayOverrides)
          .set({ kind: args.kind })
          .where(eq(schema.dayOverrides.id, existing.id));
      } else {
        await db.insert(schema.dayOverrides).values({
          shopId: args.shopId,
          date: args.date,
          kind: args.kind,
        });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  upsertMenu: defineAction({
    request: z.object({
      id: z.number().int().nullable(),
      shopId: z.number().int(),
      ownerPin: z.string().regex(/^\d{4}$/),
      name: z.string().min(1).max(50),
      price: z.number().int().min(0).max(1000000).nullable(),
      minutes: z.number().int().min(10).max(600),
    }),
    response: okShape,
    async handler(ctx, args): Promise<Ok> {
      await requireOwnerPin(ctx, args.shopId, args.ownerPin);
      const db = ctx.db<typeof schema>();
      if (args.id !== null) {
        const menuRows = await db.select().from(schema.menus).where(eq(schema.menus.id, args.id));
        const menu = menuRows[0];
        if (!menu || menu.shopId !== args.shopId) throw new Error("メニューが見つかりません");
        await db
          .update(schema.menus)
          .set({ name: args.name, price: args.price, minutes: args.minutes })
          .where(eq(schema.menus.id, args.id));
      } else {
        const rows = await db.select().from(schema.menus).where(eq(schema.menus.shopId, args.shopId));
        const maxOrder = rows.reduce((acc, m) => Math.max(acc, m.sortOrder), -1);
        await db.insert(schema.menus).values({
          shopId: args.shopId,
          name: args.name,
          price: args.price,
          minutes: args.minutes,
          sortOrder: maxOrder + 1,
        });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteMenu: defineAction({
    request: z.object({
      id: z.number().int(),
      shopId: z.number().int(),
      ownerPin: z.string().regex(/^\d{4}$/),
    }),
    response: okShape,
    async handler(ctx, args): Promise<Ok> {
      await requireOwnerPin(ctx, args.shopId, args.ownerPin);
      const db = ctx.db<typeof schema>();
      const menuRows = await db.select().from(schema.menus).where(eq(schema.menus.id, args.id));
      const menu = menuRows[0];
      if (!menu || menu.shopId !== args.shopId) throw new Error("メニューが見つかりません");
      await db.delete(schema.menus).where(eq(schema.menus.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  // ---------- admin (全体管理) ----------
  // /admin ページ専用。管理者パスワードは店主暗証番号と同じ
  // ソルト付きハッシュ形式で保存し、既知の初期パスワードは置かない。
  // 未設定の間だけ、最初に開いた管理者本人が設定できる。

  // 管理者パスワードが未設定かどうかだけを返す（パスワード自体や
  // 店舗情報は一切返さない）
  getAdminStatus: defineAction({
    request: z.object({}),
    response: z.object({ needsSetup: z.boolean() }),
    async handler(ctx): Promise<{ needsSetup: boolean }> {
      await seedIfEmpty(ctx);
      const row = await getAdminRow(ctx);
      return { needsSetup: row.isSet === 0 };
    },
  }),

  // 初回設定: 管理者パスワードが未設定の間だけ設定できる
  setupAdminPassword: defineAction({
    request: z.object({
      newPassword: z.string().min(6).max(128),
    }),
    response: pinResultShape,
    async handler(ctx, args): Promise<PinResult> {
      const row = await getAdminRow(ctx);
      if (row.isSet !== 0) {
        return { ok: false, error: "すでに管理者パスワードが設定されています" };
      }
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.adminSettings)
        .set({
          passwordHash: await hashPin(args.newPassword, ADMIN_PASSWORD_ITERATIONS),
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

  // 変更には現在のパスワードの照合が必須
  changeAdminPassword: defineAction({
    request: z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(6).max(128),
    }),
    response: pinResultShape,
    async handler(ctx, args): Promise<PinResult> {
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
          passwordHash: await hashPin(args.newPassword, ADMIN_PASSWORD_ITERATIONS),
          isSet: 1,
        })
        .where(eq(schema.adminSettings.id, 1));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 管理者専用: 全店舗の一覧（スラッグ・店主PIN設定状態つき）。
  // 未認証では何も返さない（requireAdmin が例外を投げる）
  adminListShops: defineAction({
    request: z.object({ adminPassword: z.string().min(1).max(128) }),
    response: z.object({ shops: z.array(shopShape) }),
    async handler(ctx, args): Promise<{ shops: z.infer<typeof shopShape>[] }> {
      await requireAdmin(ctx, args.adminPassword);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.shops).orderBy(asc(schema.shops.id));
      return {
        shops: rows.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          address: s.address,
          phone: s.phone,
          openTime: s.openTime,
          closeTime: s.closeTime,
          slotMinutes: s.slotMinutes,
          chairs: s.chairs,
          closedWeekdays: parseWeekdays(s.closedWeekdays),
          nthClosures: parseNth(s.nthClosures),
          pinNeedsSetup: s.pinChanged === 0,
        })),
      };
    },
  }),

  // 管理者専用: 店舗の追加。初期値は営業時間 09:00–19:00・枠30分・
  // 椅子1台・月曜＋第2/第3火曜定休・デフォルトメニュー6種で、
  // 店主暗証番号は未設定（店主本人が後で初回設定する）
  adminCreateShop: defineAction({
    request: z.object({
      adminPassword: z.string().min(1).max(128),
      name: z.string().min(1).max(50),
      slug: z.string().min(2).max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      address: z.string().max(200),
      phone: z.string().max(20),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      shopId: z.number().nullable(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null; shopId: number | null }> {
      try {
        await requireAdmin(ctx, args.adminPassword);
      } catch {
        return { ok: false, error: "管理者認証が必要です。パスワードが違います", shopId: null };
      }
      if (RESERVED_SLUGS.has(args.slug)) {
        return { ok: false, error: `「${args.slug}」はスラッグに使えません`, shopId: null };
      }
      const db = ctx.db<typeof schema>();
      const all = await db.select().from(schema.shops);
      const conflict = all.find((s) => s.slug === args.slug);
      if (conflict) {
        return {
          ok: false,
          error: `スラッグ「${args.slug}」は他のお店（${conflict.name}）で使われています`,
          shopId: null,
        };
      }
      const inserted = await db
        .insert(schema.shops)
        .values({
          name: args.name.trim(),
          slug: args.slug.trim(),
          address: args.address.trim(),
          phone: args.phone.trim(),
          ownerPin: "",
          pinChanged: 0,
          openTime: "09:00",
          closeTime: "19:00",
          slotMinutes: 30,
          chairs: 1,
          closedWeekdays: JSON.stringify([1]),
          nthClosures: JSON.stringify([
            { nth: 2, weekday: 2 },
            { nth: 3, weekday: 2 },
          ]),
        })
        .returning({ id: schema.shops.id });
      const shop = inserted[0];
      if (!shop) return { ok: false, error: "店舗の作成に失敗しました", shopId: null };
      for (let i = 0; i < DEFAULT_MENUS.length; i++) {
        const m = DEFAULT_MENUS[i];
        if (!m) continue;
        await db.insert(schema.menus).values({
          shopId: shop.id,
          name: m.name,
          price: m.price,
          minutes: m.minutes,
          sortOrder: i,
        });
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, shopId: shop.id };
    },
  }),

  // 管理者専用: 既存店舗のスラッグ変更。重複と予約語はサーバー側でも拒否する
  adminUpdateSlug: defineAction({
    request: z.object({
      adminPassword: z.string().min(1).max(128),
      shopId: z.number().int(),
      slug: z.string().min(2).max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    }),
    response: pinResultShape,
    async handler(ctx, args): Promise<PinResult> {
      try {
        await requireAdmin(ctx, args.adminPassword);
      } catch {
        return { ok: false, error: "管理者認証が必要です。パスワードが違います" };
      }
      if (RESERVED_SLUGS.has(args.slug)) {
        return { ok: false, error: `「${args.slug}」はスラッグに使えません` };
      }
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.shops).where(eq(schema.shops.id, args.shopId));
      const shop = rows[0];
      if (!shop) return { ok: false, error: "お店が見つかりません" };
      const all = await db.select().from(schema.shops);
      const conflict = all.find((s) => s.id !== args.shopId && s.slug === args.slug);
      if (conflict) {
        return {
          ok: false,
          error: `スラッグ「${args.slug}」は他のお店（${conflict.name}）で使われています`,
        };
      }
      await db
        .update(schema.shops)
        .set({ slug: args.slug })
        .where(eq(schema.shops.id, args.shopId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),
} satisfies ActionsModule;
