import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type State = ApiResponse<typeof api, "getState">;
type Shop = State["shops"][number];
type Menu = State["menus"][number];
type Booking = State["bookings"][number];
type Override = State["overrides"][number];

// ---------- date / time helpers ----------

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateStr(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

function addDays(s: string, n: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return dateStr(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function fmtDateJP(s: string): string {
  const d = parseDate(s);
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()] ?? ""}）`;
}

function toMin(t: string): number {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

function nowJSTMinutes(): number {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

function digits(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

type DayStatus = { open: boolean; label: string; override: boolean };

function dayStatus(shop: Shop, overrides: Override[], date: string): DayStatus {
  const ov = overrides.find((o) => o.shopId === shop.id && o.date === date);
  if (ov) {
    return ov.kind === "open"
      ? { open: true, label: "臨時営業", override: true }
      : { open: false, label: "臨時休業", override: true };
  }
  const d = parseDate(date);
  const weekday = d.getDay();
  const nth = Math.ceil(d.getDate() / 7);
  const closed =
    shop.closedWeekdays.includes(weekday) ||
    shop.nthClosures.some((c) => c.nth === nth && c.weekday === weekday);
  return closed
    ? { open: false, label: "定休日", override: false }
    : { open: true, label: "営業日", override: false };
}

function coveringCount(bookings: Booking[], shopId: number, date: string, atMin: number): number {
  return bookings.filter((b) => {
    if (b.shopId !== shopId || b.date !== date || b.status !== "booked") return false;
    const s = toMin(b.startTime);
    return s <= atMin && atMin < s + b.minutes;
  }).length;
}

function closedSummary(shop: Shop): string {
  const parts: string[] = [];
  if (shop.closedWeekdays.length > 0) {
    parts.push(`毎週${shop.closedWeekdays.map((w) => `${WEEKDAYS[w] ?? ""}曜`).join("・")}`);
  }
  for (const c of shop.nthClosures) {
    parts.push(`第${c.nth}${WEEKDAYS[c.weekday] ?? ""}曜`);
  }
  return parts.length > 0 ? parts.join("、") : "なし";
}

// ---------- shared UI ----------

function MonthCalendar({
  shop,
  overrides,
  bookings,
  today,
  selected,
  onSelect,
  showLoad,
}: {
  shop: Shop;
  overrides: Override[];
  bookings: Booking[];
  today: string;
  selected: string | null;
  onSelect: (date: string) => void;
  showLoad: boolean;
}) {
  const base = selected ? parseDate(selected) : parseDate(today);
  const [viewY, setViewY] = useState(base.getFullYear());
  const [viewM, setViewM] = useState(base.getMonth() + 1);

  const first = new Date(viewY, viewM - 1, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(viewY, viewM, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(dateStr(viewY, viewM, d));

  const moveMonth = (delta: number) => {
    const nm = viewM + delta;
    if (nm < 1) {
      setViewY(viewY - 1);
      setViewM(12);
    } else if (nm > 12) {
      setViewY(viewY + 1);
      setViewM(1);
    } else {
      setViewM(nm);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="前の月"
          onClick={() => moveMonth(-1)}
          className="min-h-12 min-w-12 rounded-full bg-[var(--surface-alt)] text-2xl font-bold text-[var(--text)]"
        >
          ‹
        </button>
        <p className="text-xl font-bold">
          {viewY}年{viewM}月
        </p>
        <button
          type="button"
          aria-label="次の月"
          onClick={() => moveMonth(1)}
          className="min-h-12 min-w-12 rounded-full bg-[var(--surface-alt)] text-2xl font-bold text-[var(--text)]"
        >
          ›
        </button>
      </div>
      <div className="mt-2 grid grid-cols-7 text-center text-base font-bold">
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={i === 0 ? "text-[var(--red)]" : i === 6 ? "text-[var(--accent)]" : "text-[var(--dim)]"}
          >
            {w}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((date, i) => {
          if (date === null) return <div key={`empty-${i}`} />;
          const st = dayStatus(shop, overrides, date);
          const isPast = date < today;
          const isToday = date === today;
          const isSel = date === selected;
          const dayBookings = bookings.filter(
            (b) => b.shopId === shop.id && b.date === date && b.status === "booked",
          ).length;
          return (
            <button
              key={date}
              type="button"
              disabled={isPast}
              onClick={() => onSelect(date)}
              aria-label={`${fmtDateJP(date)} ${st.label}`}
              className={[
                "flex min-h-16 flex-col items-center justify-center rounded-[var(--radius)] border-2 px-0.5 py-1",
                isSel
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]"
                  : st.open
                    ? "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                    : "border-transparent bg-[var(--surface-alt)] text-[var(--dim)]",
                isPast ? "opacity-40" : "",
                isToday && !isSel ? "ring-2 ring-[var(--red)] ring-inset" : "",
              ].join(" ")}
            >
              <span className="text-xl font-bold leading-none">{parseDate(date).getDate()}</span>
              <span className={`mt-1 text-xs font-bold leading-none ${isSel ? "" : st.open ? "text-[var(--green)]" : "text-[var(--red)]"}`}>
                {date === today ? "今日" : st.open ? "営業" : st.label === "臨時休業" ? "臨時休" : "休み"}
              </span>
              {showLoad && st.open && !isPast && (
                <span className={`text-xs leading-tight ${isSel ? "" : "text-[var(--dim)]"}`}>
                  予約{dayBookings}件
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--dim)]">
        <span>● <span className="text-[var(--green)] font-bold">営業</span>：営業日</span>
        <span>● 休み：定休日・臨時休業</span>
        <span>枠つき：今日</span>
      </div>
    </div>
  );
}

const inputCls =
  "w-full min-h-14 rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] px-4 text-lg text-[var(--text)]";
const labelCls = "block text-base font-bold text-[var(--text)] mb-1";
const bigBtnCls =
  "w-full min-h-14 rounded-[var(--radius)] bg-[var(--accent)] px-4 text-xl font-bold text-[var(--accent-text)] disabled:opacity-40";

// ---------- customer: booking flow ----------

function BookingFlow({ state, shop }: { state: State; shop: Shop }) {
  const queryClient = useQueryClient();
  const today = state.today;
  const [date, setDate] = useState<string>(today);
  const [time, setTime] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<number | null>(null);

  const menus = state.menus.filter((m) => m.shopId === shop.id);
  const status = dayStatus(shop, state.overrides, date);
  const menu = menus.find((m) => m.id === menuId) ?? null;

  const slots = useMemo(() => {
    const out: { t: string; full: boolean; past: boolean }[] = [];
    const open = toMin(shop.openTime);
    const close = toMin(shop.closeTime);
    const nowMin = nowJSTMinutes();
    for (let s = open; s < close; s += shop.slotMinutes) {
      const full = coveringCount(state.bookings, shop.id, date, s) >= shop.chairs;
      const past = date === today && s <= nowMin;
      out.push({ t: toHHMM(s), full, past });
    }
    return out;
  }, [shop, date, state.bookings, today]);

  const fitsMenu =
    time !== null && menu !== null
      ? toMin(time) + menu.minutes <= toMin(shop.closeTime)
      : null;

  const createMut = useMutation({
    mutationFn: () =>
      api.createBooking({
        shopId: shop.id,
        menuId: menuId ?? 0,
        date,
        startTime: time ?? "",
        customerName: name.trim(),
        phone: phone.trim(),
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setDoneId(res.bookingId);
        setError(null);
        void queryClient.invalidateQueries({ queryKey: ["state"] });
      } else {
        setError(res.error ?? "予約できませんでした");
      }
    },
    onError: () => setError("通信に失敗しました。もう一度お試しください"),
  });

  const canSubmit =
    status.open &&
    time !== null &&
    menu !== null &&
    fitsMenu === true &&
    name.trim().length > 0 &&
    digits(phone).length >= 10 &&
    !createMut.isPending;

  if (doneId !== null) {
    const b = state.bookings.find((x) => x.id === doneId);
    return (
      <section className="rounded-[var(--radius)] border-2 border-[var(--green)] bg-[var(--surface)] p-5 text-center">
        <p className="text-3xl font-bold text-[var(--green)]">予約が完了しました</p>
        {b ? (
          <div className="mt-4 space-y-1 text-lg">
            <p className="font-bold">{shop.name}</p>
            <p>{fmtDateJP(b.date)} {b.startTime}〜</p>
            <p>{b.menuName}（{b.minutes}分）</p>
            <p>{b.customerName} 様</p>
          </div>
        ) : null}
        <p className="mt-4 text-base text-[var(--dim)]">
          当日は時間までにご来店ください。変更・キャンセルは下の「自分の予約を確認」からできます。
        </p>
        <button
          type="button"
          className={`${bigBtnCls} mt-5`}
          onClick={() => {
            setDoneId(null);
            setTime(null);
            setMenuId(null);
          }}
        >
          続けて予約する
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-2xl font-bold">1. 日付を選ぶ</h2>
        <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-3 shadow-sm">
          <MonthCalendar
            shop={shop}
            overrides={state.overrides}
            bookings={state.bookings}
            today={today}
            selected={date}
            onSelect={(d) => {
              setDate(d);
              setTime(null);
            }}
            showLoad={false}
          />
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-bold">2. 時間を選ぶ</h2>
        <p className="mt-1 text-lg font-bold text-[var(--accent)]">{fmtDateJP(date)}</p>
        {!status.open ? (
          <p className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] p-4 text-lg font-bold text-[var(--red)]">
            この日は{status.label}です。営業日を選んでください。
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {slots.map((s) => {
              const disabled = s.full || s.past;
              const sel = time === s.t;
              return (
                <button
                  key={s.t}
                  type="button"
                  disabled={disabled}
                  onClick={() => setTime(s.t)}
                  aria-label={`${s.t} ${s.full ? "満席" : s.past ? "受付終了" : "空きあり"}`}
                  className={[
                    "flex min-h-16 flex-col items-center justify-center rounded-[var(--radius)] border-2",
                    sel
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]"
                      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
                    disabled ? "opacity-40" : "",
                  ].join(" ")}
                >
                  <span className="text-xl font-bold leading-none">{s.t}</span>
                  <span className={`mt-1 text-sm font-bold ${sel ? "" : s.full ? "text-[var(--red)]" : "text-[var(--green)]"}`}>
                    {s.full ? "満席" : s.past ? "終了" : "空きあり"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-2xl font-bold">3. メニューを選ぶ</h2>
        <div className="mt-3 space-y-2">
          {menus.map((m) => {
            const sel = menuId === m.id;
            const tooLong =
              time !== null && toMin(time) + m.minutes > toMin(shop.closeTime);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setMenuId(m.id)}
                aria-pressed={sel}
                className={[
                  "flex w-full min-h-16 items-center justify-between rounded-[var(--radius)] border-2 px-4 py-3 text-left",
                  sel
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]"
                    : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
                ].join(" ")}
              >
                <span>
                  <span className="block text-xl font-bold">{m.name}</span>
                  <span className={`text-base ${sel ? "" : "text-[var(--dim)]"}`}>
                    約{m.minutes}分
                    {tooLong ? "（選んだ時間では終わりません）" : ""}
                  </span>
                </span>
                <span className="text-xl font-bold">
                  {m.price !== null ? `¥${m.price.toLocaleString()}` : "料金は店頭で"}
                </span>
              </button>
            );
          })}
          {menus.length === 0 && (
            <p className="text-lg text-[var(--dim)]">メニューが登録されていません。</p>
          )}
        </div>
        {time !== null && menu !== null && fitsMenu === false && (
          <p className="mt-2 text-lg font-bold text-[var(--red)]">
            「{menu.name}」は {time} からでは営業時間内に終わりません。早い時間を選んでください。
          </p>
        )}
      </section>

      <section>
        <h2 className="text-2xl font-bold">4. お名前と電話番号</h2>
        <div className="mt-3 space-y-4">
          <div>
            <label htmlFor="bf-name" className={labelCls}>お名前</label>
            <input
              id="bf-name"
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：山田 太郎"
              autoComplete="name"
            />
          </div>
          <div>
            <label htmlFor="bf-phone" className={labelCls}>電話番号（予約の確認・キャンセルに使います）</label>
            <input
              id="bf-phone"
              className={inputCls}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="例：09012345678"
              inputMode="tel"
              autoComplete="tel"
            />
          </div>
        </div>
        {error && (
          <p className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] p-4 text-lg font-bold text-[var(--red)]">
            {error}
          </p>
        )}
        <button
          type="button"
          className={`${bigBtnCls} mt-5`}
          disabled={!canSubmit}
          onClick={() => createMut.mutate()}
        >
          {createMut.isPending ? "予約しています…" : "この内容で予約する"}
        </button>
        {!canSubmit && (
          <p className="mt-2 text-center text-base text-[var(--dim)]">
            日付・時間・メニュー・お名前・電話番号をすべて入れると押せます
          </p>
        )}
      </section>
    </div>
  );
}

// ---------- customer: my bookings ----------

function MyBookings({ state }: { state: State }) {
  const queryClient = useQueryClient();
  const [phoneInput, setPhoneInput] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const mine =
    searched === null
      ? []
      : state.bookings
          .filter(
            (b) =>
              digits(b.phone) === digits(searched) &&
              b.status === "booked" &&
              b.date >= state.today,
          )
          .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  const cancelMut = useMutation({
    mutationFn: (b: Booking) => api.cancelBooking({ id: b.id, phone: searched ?? "" }),
    onSuccess: (res) => {
      if (res.ok) {
        setMsg("予約を取り消しました");
        setConfirmId(null);
        void queryClient.invalidateQueries({ queryKey: ["state"] });
      } else {
        setMsg(res.error ?? "取り消せませんでした");
      }
    },
    onError: () => setMsg("通信に失敗しました"),
  });

  return (
    <section className="mt-10">
      <h2 className="text-2xl font-bold">自分の予約を確認・キャンセル</h2>
      <p className="mt-1 text-base text-[var(--dim)]">
        予約したときの電話番号を入れると、自分の予約が表示されます。
      </p>
      <div className="mt-3 flex gap-2">
        <input
          aria-label="予約確認用の電話番号"
          className={inputCls}
          value={phoneInput}
          onChange={(e) => setPhoneInput(e.target.value)}
          placeholder="電話番号"
          inputMode="tel"
        />
        <button
          type="button"
          className="min-h-14 shrink-0 rounded-[var(--radius)] bg-[var(--accent)] px-5 text-xl font-bold text-[var(--accent-text)] disabled:opacity-40"
          disabled={digits(phoneInput).length < 10}
          onClick={() => {
            setSearched(phoneInput);
            setMsg(null);
          }}
        >
          確認
        </button>
      </div>
      {msg && <p className="mt-3 text-lg font-bold text-[var(--green)]">{msg}</p>}
      {searched !== null && (
        <div className="mt-4 space-y-3">
          {mine.length === 0 && (
            <p className="text-lg text-[var(--dim)]">この電話番号の今後の予約はありません。</p>
          )}
          {mine.map((b) => {
            const shop = state.shops.find((s) => s.id === b.shopId);
            return (
              <div key={b.id} className="rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="text-xl font-bold">{shop?.name ?? ""}</p>
                <p className="mt-1 text-lg">
                  {fmtDateJP(b.date)} {b.startTime}〜{toHHMM(toMin(b.startTime) + b.minutes)}
                </p>
                <p className="text-lg">{b.menuName}（{b.minutes}分）／{b.customerName} 様</p>
                {confirmId === b.id ? (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className="min-h-12 flex-1 rounded-[var(--radius)] bg-[var(--red)] px-3 text-lg font-bold text-white"
                      onClick={() => cancelMut.mutate(b)}
                    >
                      本当に取り消す
                    </button>
                    <button
                      type="button"
                      className="min-h-12 flex-1 rounded-[var(--radius)] bg-[var(--surface-alt)] px-3 text-lg font-bold"
                      onClick={() => setConfirmId(null)}
                    >
                      やめる
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="mt-3 min-h-12 w-full rounded-[var(--radius)] border-2 border-[var(--red)] px-3 text-lg font-bold text-[var(--red)]"
                    onClick={() => setConfirmId(b.id)}
                  >
                    この予約を取り消す
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------- owner: booking list + manual add ----------

function OwnerBookings({ state, shop }: { state: State; shop: Shop }) {
  const queryClient = useQueryClient();
  const [range, setRange] = useState<"today" | "week">("today");
  const [confirmId, setConfirmId] = useState<number | null>(null);

  // manual add form
  const menus = state.menus.filter((m) => m.shopId === shop.id);
  const [mDate, setMDate] = useState(state.today);
  const [mTime, setMTime] = useState("10:00");
  const [mMenuId, setMMenuId] = useState<number>(menus[0]?.id ?? 0);
  const [mName, setMName] = useState("");
  const [mPhone, setMPhone] = useState("");
  const [mMsg, setMMsg] = useState<string | null>(null);
  const [mError, setMError] = useState<string | null>(null);

  useEffect(() => {
    if (mMenuId === 0 && menus.length > 0) setMMenuId(menus[0]?.id ?? 0);
  }, [menus, mMenuId]);

  const endDate = range === "today" ? state.today : addDays(state.today, 6);
  const list = state.bookings
    .filter(
      (b) =>
        b.shopId === shop.id &&
        b.status === "booked" &&
        b.date >= state.today &&
        b.date <= endDate,
    )
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  const dates: string[] = [];
  for (const b of list) if (!dates.includes(b.date)) dates.push(b.date);

  const cancelMut = useMutation({
    mutationFn: (id: number) => api.cancelBooking({ id }),
    onSuccess: () => {
      setConfirmId(null);
      void queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const addMut = useMutation({
    mutationFn: () =>
      api.createBooking({
        shopId: shop.id,
        menuId: mMenuId,
        date: mDate,
        startTime: mTime,
        customerName: mName.trim(),
        phone: mPhone.trim(),
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setMMsg("予約を追加しました");
        setMError(null);
        setMName("");
        setMPhone("");
        void queryClient.invalidateQueries({ queryKey: ["state"] });
      } else {
        setMError(res.error ?? "追加できませんでした");
        setMMsg(null);
      }
    },
    onError: () => setMError("通信に失敗しました"),
  });

  const slotOptions: string[] = [];
  for (let s = toMin(shop.openTime); s < toMin(shop.closeTime); s += shop.slotMinutes) {
    slotOptions.push(toHHMM(s));
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="flex gap-2" role="tablist" aria-label="予約一覧の範囲">
          {(["today", "week"] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={range === r}
              onClick={() => setRange(r)}
              className={`min-h-12 flex-1 rounded-[var(--radius)] text-lg font-bold ${
                range === r
                  ? "bg-[var(--accent)] text-[var(--accent-text)]"
                  : "bg-[var(--surface-alt)] text-[var(--text)]"
              }`}
            >
              {r === "today" ? "今日の予約" : "今週の予約"}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-5">
          {list.length === 0 && (
            <p className="rounded-[var(--radius)] bg-[var(--surface)] p-5 text-center text-lg text-[var(--dim)]">
              {range === "today" ? "今日の予約はまだありません。" : "今週の予約はまだありません。"}
            </p>
          )}
          {dates.map((d) => (
            <div key={d}>
              <h3 className="text-xl font-bold">
                {fmtDateJP(d)}
                {d === state.today ? "（今日）" : ""}
                <span className="ml-2 text-base text-[var(--dim)]">
                  {list.filter((b) => b.date === d).length}件
                </span>
              </h3>
              <div className="mt-2 space-y-2">
                {list
                  .filter((b) => b.date === d)
                  .map((b) => (
                    <div key={b.id} className="rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-2xl font-bold">
                            {b.startTime}〜{toHHMM(toMin(b.startTime) + b.minutes)}
                          </p>
                          <p className="text-lg font-bold">{b.customerName} 様</p>
                          <p className="text-lg">{b.menuName}（{b.minutes}分）</p>
                          <p className="text-base text-[var(--dim)]">
                            電話：<a href={`tel:${digits(b.phone)}`} className="underline">{b.phone}</a>
                          </p>
                        </div>
                        {confirmId === b.id ? (
                          <div className="flex flex-col gap-2">
                            <button
                              type="button"
                              className="min-h-12 rounded-[var(--radius)] bg-[var(--red)] px-4 text-lg font-bold text-white"
                              onClick={() => cancelMut.mutate(b.id)}
                            >
                              本当に取消
                            </button>
                            <button
                              type="button"
                              className="min-h-12 rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 text-lg font-bold"
                              onClick={() => setConfirmId(null)}
                            >
                              やめる
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="min-h-12 shrink-0 rounded-[var(--radius)] border-2 border-[var(--red)] px-4 text-lg font-bold text-[var(--red)]"
                            onClick={() => setConfirmId(b.id)}
                          >
                            取消
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <h3 className="text-xl font-bold">電話で受けた予約を追加</h3>
        <div className="mt-3 space-y-4">
          <div>
            <label htmlFor="ma-date" className={labelCls}>日付</label>
            <input id="ma-date" type="date" className={inputCls} value={mDate} min={state.today}
              onChange={(e) => setMDate(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ma-time" className={labelCls}>開始時間</label>
              <select id="ma-time" className={inputCls} value={mTime} onChange={(e) => setMTime(e.target.value)}>
                {slotOptions.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ma-menu" className={labelCls}>メニュー</label>
              <select id="ma-menu" className={inputCls} value={mMenuId} onChange={(e) => setMMenuId(Number(e.target.value))}>
                {menus.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}（{m.minutes}分）</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="ma-name" className={labelCls}>お名前</label>
            <input id="ma-name" className={inputCls} value={mName} onChange={(e) => setMName(e.target.value)} placeholder="例：佐藤 一郎" />
          </div>
          <div>
            <label htmlFor="ma-phone" className={labelCls}>電話番号</label>
            <input id="ma-phone" className={inputCls} value={mPhone} onChange={(e) => setMPhone(e.target.value)} placeholder="例：09012345678" inputMode="tel" />
          </div>
          {mError && <p className="text-lg font-bold text-[var(--red)]">{mError}</p>}
          {mMsg && <p className="text-lg font-bold text-[var(--green)]">{mMsg}</p>}
          <button
            type="button"
            className={bigBtnCls}
            disabled={mName.trim().length === 0 || digits(mPhone).length < 10 || mMenuId === 0 || addMut.isPending}
            onClick={() => addMut.mutate()}
          >
            予約を追加する
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------- owner: calendar edit ----------

function CalendarEdit({ state, shop }: { state: State; shop: Shop }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>(state.today);
  const [closedWeekdays, setClosedWeekdays] = useState<number[]>(shop.closedWeekdays);
  const [nthClosures, setNthClosures] = useState<{ nth: number; weekday: number }[]>(shop.nthClosures);
  const [addNth, setAddNth] = useState(1);
  const [addWeekday, setAddWeekday] = useState(1);
  const [ruleMsg, setRuleMsg] = useState<string | null>(null);

  useEffect(() => {
    setClosedWeekdays(shop.closedWeekdays);
    setNthClosures(shop.nthClosures);
  }, [shop.id, shop.closedWeekdays, shop.nthClosures]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["state"] });

  const saveRulesMut = useMutation({
    mutationFn: () =>
      api.updateShop({
        id: shop.id,
        name: shop.name,
        address: shop.address,
        phone: shop.phone,
        openTime: shop.openTime,
        closeTime: shop.closeTime,
        slotMinutes: shop.slotMinutes,
        chairs: shop.chairs,
        closedWeekdays,
        nthClosures,
      }),
    onSuccess: () => {
      setRuleMsg("定休日を保存しました");
      invalidate();
    },
    onError: () => setRuleMsg("保存に失敗しました"),
  });

  const overrideMut = useMutation({
    mutationFn: (kind: "closed" | "open" | "clear") =>
      api.setDayOverride({ shopId: shop.id, date: selected, kind }),
    onSuccess: invalidate,
  });

  const selStatus = dayStatus(shop, state.overrides, selected);
  const selOverride = state.overrides.find((o) => o.shopId === shop.id && o.date === selected);

  return (
    <div className="space-y-8">
      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <h3 className="text-xl font-bold">定休日のルール</h3>
        <p className="mt-1 text-base text-[var(--dim)]">毎週休む曜日</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {WEEKDAYS.map((w, i) => {
            const on = closedWeekdays.includes(i);
            return (
              <button
                key={w}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setClosedWeekdays(on ? closedWeekdays.filter((x) => x !== i) : [...closedWeekdays, i])
                }
                className={`min-h-14 min-w-14 rounded-full text-xl font-bold ${
                  on ? "bg-[var(--red)] text-white" : "bg-[var(--surface-alt)] text-[var(--text)]"
                }`}
              >
                {w}
              </button>
            );
          })}
        </div>
        <p className="mt-4 text-base text-[var(--dim)]">「第○週の○曜日」だけ休む（例：第2・第3火曜）</p>
        <div className="mt-2 space-y-2">
          {nthClosures.map((c, i) => (
            <div key={`${c.nth}-${c.weekday}-${i}`} className="flex items-center justify-between rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 py-2">
              <span className="text-lg font-bold">第{c.nth} {WEEKDAYS[c.weekday] ?? ""}曜日</span>
              <button
                type="button"
                aria-label={`第${c.nth}${WEEKDAYS[c.weekday] ?? ""}曜の定休を削除`}
                className="min-h-11 rounded-[var(--radius)] border-2 border-[var(--red)] px-3 text-base font-bold text-[var(--red)]"
                onClick={() => setNthClosures(nthClosures.filter((_, j) => j !== i))}
              >
                削除
              </button>
            </div>
          ))}
          {nthClosures.length === 0 && <p className="text-base text-[var(--dim)]">設定なし</p>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select aria-label="第何週" className="min-h-12 rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] px-3 text-lg"
            value={addNth} onChange={(e) => setAddNth(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>第{n}週</option>
            ))}
          </select>
          <select aria-label="追加する曜日" className="min-h-12 rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] px-3 text-lg"
            value={addWeekday} onChange={(e) => setAddWeekday(Number(e.target.value))}>
            {WEEKDAYS.map((w, i) => (
              <option key={w} value={i}>{w}曜日</option>
            ))}
          </select>
          <button
            type="button"
            className="min-h-12 rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 text-lg font-bold"
            onClick={() => {
              if (!nthClosures.some((c) => c.nth === addNth && c.weekday === addWeekday)) {
                setNthClosures([...nthClosures, { nth: addNth, weekday: addWeekday }]);
              }
            }}
          >
            追加
          </button>
        </div>
        {ruleMsg && <p className="mt-3 text-lg font-bold text-[var(--green)]">{ruleMsg}</p>}
        <button type="button" className={`${bigBtnCls} mt-4`} disabled={saveRulesMut.isPending}
          onClick={() => saveRulesMut.mutate()}>
          定休日を保存する
        </button>
      </section>

      <section>
        <h3 className="text-xl font-bold">日ごとの臨時休業・臨時営業</h3>
        <p className="mt-1 text-base text-[var(--dim)]">カレンダーの日付をタップして選んでください。</p>
        <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-3 shadow-sm">
          <MonthCalendar
            shop={shop}
            overrides={state.overrides}
            bookings={state.bookings}
            today={state.today}
            selected={selected}
            onSelect={setSelected}
            showLoad
          />
        </div>
        <div className="mt-4 rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
          <p className="text-xl font-bold">
            {fmtDateJP(selected)}：現在は「{selStatus.label}」
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              type="button"
              className="min-h-14 rounded-[var(--radius)] bg-[var(--red)] px-3 text-lg font-bold text-white disabled:opacity-40"
              disabled={selOverride?.kind === "closed"}
              onClick={() => overrideMut.mutate("closed")}
            >
              臨時休業にする
            </button>
            <button
              type="button"
              className="min-h-14 rounded-[var(--radius)] bg-[var(--green)] px-3 text-lg font-bold text-white disabled:opacity-40"
              disabled={selOverride?.kind === "open"}
              onClick={() => overrideMut.mutate("open")}
            >
              臨時営業にする
            </button>
            <button
              type="button"
              className="min-h-14 rounded-[var(--radius)] bg-[var(--surface-alt)] px-3 text-lg font-bold disabled:opacity-40"
              disabled={!selOverride}
              onClick={() => overrideMut.mutate("clear")}
            >
              通常に戻す
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------- owner: settings ----------

function Settings({ state, shop }: { state: State; shop: Shop }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(shop.name);
  const [address, setAddress] = useState(shop.address);
  const [phone, setPhone] = useState(shop.phone);
  const [openTime, setOpenTime] = useState(shop.openTime);
  const [closeTime, setCloseTime] = useState(shop.closeTime);
  const [slotMinutes, setSlotMinutes] = useState(shop.slotMinutes);
  const [chairs, setChairs] = useState(shop.chairs);
  const [shopMsg, setShopMsg] = useState<string | null>(null);

  const [editMenuId, setEditMenuId] = useState<number | null>(null);
  const [menuName, setMenuName] = useState("");
  const [menuPrice, setMenuPrice] = useState("");
  const [menuMinutes, setMenuMinutes] = useState("60");
  const [menuMsg, setMenuMsg] = useState<string | null>(null);
  const [confirmDeleteMenu, setConfirmDeleteMenu] = useState<number | null>(null);

  useEffect(() => {
    setName(shop.name);
    setAddress(shop.address);
    setPhone(shop.phone);
    setOpenTime(shop.openTime);
    setCloseTime(shop.closeTime);
    setSlotMinutes(shop.slotMinutes);
    setChairs(shop.chairs);
    setEditMenuId(null);
    setMenuName("");
    setMenuPrice("");
    setMenuMinutes("60");
  }, [shop]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["state"] });
  const menus = state.menus.filter((m) => m.shopId === shop.id);

  const saveShopMut = useMutation({
    mutationFn: () =>
      api.updateShop({
        id: shop.id,
        name: name.trim(),
        address: address.trim(),
        phone: phone.trim(),
        openTime,
        closeTime,
        slotMinutes,
        chairs,
        closedWeekdays: shop.closedWeekdays,
        nthClosures: shop.nthClosures,
      }),
    onSuccess: () => {
      setShopMsg("お店の設定を保存しました");
      invalidate();
    },
    onError: () => setShopMsg("保存に失敗しました"),
  });

  const saveMenuMut = useMutation({
    mutationFn: () =>
      api.upsertMenu({
        id: editMenuId,
        shopId: shop.id,
        name: menuName.trim(),
        price: menuPrice.trim() === "" ? null : Number(menuPrice),
        minutes: Number(menuMinutes),
      }),
    onSuccess: () => {
      setMenuMsg(editMenuId === null ? "メニューを追加しました" : "メニューを保存しました");
      setEditMenuId(null);
      setMenuName("");
      setMenuPrice("");
      setMenuMinutes("60");
      invalidate();
    },
    onError: () => setMenuMsg("保存に失敗しました"),
  });

  const deleteMenuMut = useMutation({
    mutationFn: (id: number) => api.deleteMenu({ id }),
    onSuccess: () => {
      setConfirmDeleteMenu(null);
      invalidate();
    },
  });

  const menuValid =
    menuName.trim().length > 0 &&
    Number(menuMinutes) >= 10 &&
    (menuPrice.trim() === "" || (!Number.isNaN(Number(menuPrice)) && Number(menuPrice) >= 0));

  return (
    <div className="space-y-8">
      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <h3 className="text-xl font-bold">お店の情報</h3>
        <div className="mt-3 space-y-4">
          <div>
            <label htmlFor="st-name" className={labelCls}>店名</label>
            <input id="st-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="st-address" className={labelCls}>住所</label>
            <input id="st-address" className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="例：東京都○○区…" />
          </div>
          <div>
            <label htmlFor="st-phone" className={labelCls}>電話番号</label>
            <input id="st-phone" className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="例：03-1234-5678" inputMode="tel" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="st-open" className={labelCls}>開店時間</label>
              <input id="st-open" type="time" className={inputCls} value={openTime} onChange={(e) => setOpenTime(e.target.value)} />
            </div>
            <div>
              <label htmlFor="st-close" className={labelCls}>閉店時間</label>
              <input id="st-close" type="time" className={inputCls} value={closeTime} onChange={(e) => setCloseTime(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="st-slot" className={labelCls}>予約枠の単位</label>
              <select id="st-slot" className={inputCls} value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))}>
                {[15, 20, 30, 60].map((n) => (
                  <option key={n} value={n}>{n}分</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="st-chairs" className={labelCls}>椅子の数（同時受付）</label>
              <select id="st-chairs" className={inputCls} value={chairs} onChange={(e) => setChairs(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n}台</option>
                ))}
              </select>
            </div>
          </div>
          {shopMsg && <p className="text-lg font-bold text-[var(--green)]">{shopMsg}</p>}
          <button type="button" className={bigBtnCls} disabled={name.trim().length === 0 || saveShopMut.isPending}
            onClick={() => saveShopMut.mutate()}>
            お店の設定を保存する
          </button>
        </div>
      </section>

      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <h3 className="text-xl font-bold">メニュー・料金</h3>
        <p className="mt-1 text-base text-[var(--dim)]">
          料金・所要時間は仮の初期値です。実際のお店の価格に直してください。
        </p>
        <div className="mt-3 space-y-2">
          {menus.map((m) => (
            <div key={m.id} className="rounded-[var(--radius)] border-2 border-[var(--border)] px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-lg font-bold">{m.name}</p>
                  <p className="text-base text-[var(--dim)]">
                    {m.price !== null ? `¥${m.price.toLocaleString()}` : "料金未設定"}／約{m.minutes}分
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className="min-h-11 rounded-[var(--radius)] bg-[var(--surface-alt)] px-3 text-base font-bold"
                    onClick={() => {
                      setEditMenuId(m.id);
                      setMenuName(m.name);
                      setMenuPrice(m.price !== null ? String(m.price) : "");
                      setMenuMinutes(String(m.minutes));
                      setMenuMsg(null);
                    }}
                  >
                    編集
                  </button>
                  {confirmDeleteMenu === m.id ? (
                    <button
                      type="button"
                      className="min-h-11 rounded-[var(--radius)] bg-[var(--red)] px-3 text-base font-bold text-white"
                      onClick={() => deleteMenuMut.mutate(m.id)}
                    >
                      本当に削除
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="min-h-11 rounded-[var(--radius)] border-2 border-[var(--red)] px-3 text-base font-bold text-[var(--red)]"
                      onClick={() => setConfirmDeleteMenu(m.id)}
                    >
                      削除
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {menus.length === 0 && <p className="text-base text-[var(--dim)]">メニューはありません。下から追加できます。</p>}
        </div>

        <div className="mt-5 border-t-2 border-[var(--border)] pt-4">
          <h4 className="text-lg font-bold">{editMenuId === null ? "メニューを追加" : "メニューを編集中"}</h4>
          <div className="mt-3 space-y-4">
            <div>
              <label htmlFor="mn-name" className={labelCls}>メニュー名</label>
              <input id="mn-name" className={inputCls} value={menuName} onChange={(e) => setMenuName(e.target.value)} placeholder="例：カット" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="mn-price" className={labelCls}>料金（円・空欄可）</label>
                <input id="mn-price" className={inputCls} value={menuPrice} onChange={(e) => setMenuPrice(e.target.value)} placeholder="例：4000" inputMode="numeric" />
              </div>
              <div>
                <label htmlFor="mn-min" className={labelCls}>所要時間（分）</label>
                <input id="mn-min" className={inputCls} value={menuMinutes} onChange={(e) => setMenuMinutes(e.target.value)} placeholder="例：60" inputMode="numeric" />
              </div>
            </div>
            {menuMsg && <p className="text-lg font-bold text-[var(--green)]">{menuMsg}</p>}
            <div className="flex gap-2">
              <button type="button" className={`${bigBtnCls} flex-1`} disabled={!menuValid || saveMenuMut.isPending}
                onClick={() => saveMenuMut.mutate()}>
                {editMenuId === null ? "追加する" : "保存する"}
              </button>
              {editMenuId !== null && (
                <button type="button" className="min-h-14 rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 text-lg font-bold"
                  onClick={() => {
                    setEditMenuId(null);
                    setMenuName("");
                    setMenuPrice("");
                    setMenuMinutes("60");
                  }}>
                  やめる
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------- root ----------

export function App() {
  const stateQ = useQuery({ queryKey: ["state"], queryFn: () => api.getState({}) });
  const [shopId, setShopId] = useState<number | null>(null);
  const [mode, setMode] = useState<"customer" | "owner">("customer");
  const [ownerTab, setOwnerTab] = useState<"bookings" | "calendar" | "settings">("bookings");

  const state = stateQ.data;
  const shop =
    state?.shops.find((s) => s.id === shopId) ?? state?.shops[0] ?? null;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-16">
        {stateQ.isPending && (
          <p className="py-16 text-center text-xl">読み込んでいます…</p>
        )}
        {stateQ.error && (
          <div className="py-16 text-center">
            <p className="text-xl font-bold text-[var(--red)]">読み込みに失敗しました</p>
            <button
              type="button"
              className={`${bigBtnCls} mt-4`}
              onClick={() => void stateQ.refetch()}
            >
              もう一度読み込む
            </button>
          </div>
        )}

        {state && shop && (
          <>
            {/* shop switcher */}
            <div className="pt-4">
              <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="お店の切り替え">
                {state.shops.map((s) => {
                  const active = s.id === shop.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setShopId(s.id)}
                      className={`min-h-16 rounded-[var(--radius)] border-b-8 px-3 py-2 text-xl font-bold ${
                        active
                          ? "border-[var(--red)] bg-[var(--accent)] text-[var(--accent-text)]"
                          : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                      }`}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
                <h1 className="text-3xl font-bold">{shop.name}</h1>
                <div className="mt-2 space-y-1 text-lg">
                  <p>
                    営業時間：{shop.openTime}〜{shop.closeTime}
                  </p>
                  <p>定休日：{closedSummary(shop)}</p>
                  {shop.address && <p>住所：{shop.address}</p>}
                  {shop.phone && (
                    <p>
                      電話：
                      <a href={`tel:${digits(shop.phone)}`} className="font-bold text-[var(--accent)] underline">
                        {shop.phone}
                      </a>
                    </p>
                  )}
                  {!shop.address && !shop.phone && (
                    <p className="text-base text-[var(--dim)]">
                      住所・電話番号は店主画面の「設定」から登録できます。
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* mode switch */}
            <div className="mt-5 grid grid-cols-2 gap-2" role="tablist" aria-label="画面の切り替え">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "customer"}
                onClick={() => setMode("customer")}
                className={`min-h-14 rounded-full text-xl font-bold ${
                  mode === "customer"
                    ? "bg-[var(--red)] text-white"
                    : "bg-[var(--surface-alt)] text-[var(--text)]"
                }`}
              >
                予約する・確認
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "owner"}
                onClick={() => setMode("owner")}
                className={`min-h-14 rounded-full text-xl font-bold ${
                  mode === "owner"
                    ? "bg-[var(--red)] text-white"
                    : "bg-[var(--surface-alt)] text-[var(--text)]"
                }`}
              >
                店主画面
              </button>
            </div>

            <div className="mt-6">
              {mode === "customer" ? (
                <>
                  <BookingFlow key={`bf-${shop.id}`} state={state} shop={shop} />
                  <MyBookings state={state} />
                </>
              ) : (
                <>
                  <div className="mb-5 grid grid-cols-3 gap-2" role="tablist" aria-label="店主画面の切り替え">
                    {(
                      [
                        ["bookings", "予約一覧"],
                        ["calendar", "営業日編集"],
                        ["settings", "設定"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={ownerTab === key}
                        onClick={() => setOwnerTab(key)}
                        className={`min-h-12 rounded-[var(--radius)] px-2 text-lg font-bold ${
                          ownerTab === key
                            ? "bg-[var(--accent)] text-[var(--accent-text)]"
                            : "bg-[var(--surface-alt)] text-[var(--text)]"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {ownerTab === "bookings" && (
                    <OwnerBookings key={`ob-${shop.id}`} state={state} shop={shop} />
                  )}
                  {ownerTab === "calendar" && (
                    <CalendarEdit key={`ce-${shop.id}`} state={state} shop={shop} />
                  )}
                  {ownerTab === "settings" && (
                    <Settings key={`st-${shop.id}`} state={state} shop={shop} />
                  )}
                </>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
