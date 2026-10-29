import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
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

const DEFAULT_MENUS: { name: string; price: number; minutes: number }[] = [
  { name: "カット", price: 4000, minutes: 60 },
  { name: "カット＋顔剃り", price: 4500, minutes: 60 },
  { name: "カット＋シャンプー", price: 4500, minutes: 60 },
  { name: "顔剃り", price: 1500, minutes: 30 },
  { name: "カラー（白髪染め）", price: 6000, minutes: 90 },
  { name: "パーマ", price: 8000, minutes: 120 },
];

async function seedIfEmpty(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const existing = await db.select().from(schema.shops).limit(1);
  if (existing.length > 0) return;
  const defaults = [
    { name: "お父さんの店" },
    { name: "おじさんの店" },
  ];
  for (const d of defaults) {
    const inserted = await db
      .insert(schema.shops)
      .values({
        name: d.name,
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
  name: z.string(),
  address: z.string(),
  phone: z.string(),
  openTime: z.string(),
  closeTime: z.string(),
  slotMinutes: z.number(),
  chairs: z.number(),
  closedWeekdays: z.array(z.number()),
  nthClosures: z.array(z.object({ nth: z.number(), weekday: z.number() })),
});

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
      bookings: z.array(bookingShape),
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
          name: s.name,
          address: s.address,
          phone: s.phone,
          openTime: s.openTime,
          closeTime: s.closeTime,
          slotMinutes: s.slotMinutes,
          chairs: s.chairs,
          closedWeekdays: parseWeekdays(s.closedWeekdays),
          nthClosures: parseNth(s.nthClosures),
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
          customerName: b.customerName,
          phone: b.phone,
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
    }),
    response: bookingResultShape,
    async handler(ctx, args): Promise<BookingResult> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.bookings).where(eq(schema.bookings.id, args.id));
      const b = rows[0];
      if (!b) return { ok: false, error: "予約が見つかりません", bookingId: null };
      if (args.phone !== undefined && digits(args.phone) !== digits(b.phone)) {
        return { ok: false, error: "電話番号が予約と一致しません", bookingId: null };
      }
      await db
        .update(schema.bookings)
        .set({ status: "cancelled" })
        .where(eq(schema.bookings.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null, bookingId: args.id };
    },
  }),

  updateShop: defineAction({
    request: z.object({
      id: z.number().int(),
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
    response: okShape,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.shops)
        .set({
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
      return { ok: true };
    },
  }),

  setDayOverride: defineAction({
    request: z.object({
      shopId: z.number().int(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      kind: z.enum(["closed", "open", "clear"]),
    }),
    response: okShape,
    async handler(ctx, args): Promise<Ok> {
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
      name: z.string().min(1).max(50),
      price: z.number().int().min(0).max(1000000).nullable(),
      minutes: z.number().int().min(10).max(600),
    }),
    response: okShape,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      if (args.id !== null) {
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
    request: z.object({ id: z.number().int() }),
    response: okShape,
    async handler(ctx, args): Promise<Ok> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.menus).where(eq(schema.menus.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
