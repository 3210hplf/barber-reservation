import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "./SafeArea";
import { api, type ApiResponse } from "./api";

type State = ApiResponse<typeof api, "getState">;
type Shop = State["shops"][number];
type Booking = State["bookings"][number];
// 氏名・電話番号つきの予約（店主認証後／自分の電話番号での検索でのみ取得）
type FullBooking = ApiResponse<typeof api, "getOwnerBookings">["bookings"][number];
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
  const [doneInfo, setDoneInfo] = useState<{
    date: string;
    startTime: string;
    menuName: string;
    minutes: number;
    customerName: string;
  } | null>(null);

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
        // 完了画面は送信した内容そのもので表示する（公開データに氏名は含まれない）
        if (menu !== null && time !== null) {
          setDoneInfo({
            date,
            startTime: time,
            menuName: menu.name,
            minutes: menu.minutes,
            customerName: name.trim(),
          });
        }
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

  if (doneInfo !== null) {
    const b = doneInfo;
    return (
      <section className="rounded-[var(--radius)] border-2 border-[var(--green)] bg-[var(--surface)] p-5 text-center">
        <p className="text-3xl font-bold text-[var(--green)]">予約が完了しました</p>
        <div className="mt-4 space-y-1 text-lg">
          <p className="font-bold">{shop.name}</p>
          <p>{fmtDateJP(b.date)} {b.startTime}〜</p>
          <p>{b.menuName}（{b.minutes}分）</p>
          <p>{b.customerName} 様</p>
        </div>
        <p className="mt-4 text-base text-[var(--dim)]">
          当日は時間までにご来店ください。変更・キャンセルは下の「自分の予約を確認」からできます。
        </p>
        <button
          type="button"
          className={`${bigBtnCls} mt-5`}
          onClick={() => {
            setDoneInfo(null);
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

function MyBookings({ shop }: { shop: Shop }) {
  const queryClient = useQueryClient();
  const [phoneInput, setPhoneInput] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [mine, setMine] = useState<FullBooking[]>([]);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 自分の予約は電話番号をサーバーに送って、この店舗の範囲だけで検索する
  // （全員の予約は端末に渡らない）
  const searchMut = useMutation({
    mutationFn: (phone: string) => api.lookupMyBookings({ shopId: shop.id, phone }),
    onSuccess: (res) => {
      setMine(res.bookings);
    },
    onError: () => setMsg("通信に失敗しました"),
  });

  const cancelMut = useMutation({
    mutationFn: (b: FullBooking) => api.cancelBooking({ id: b.id, phone: searched ?? "" }),
    onSuccess: (res, b) => {
      if (res.ok) {
        setMsg("予約を取り消しました");
        setConfirmId(null);
        setMine((prev) => prev.filter((x) => x.id !== b.id));
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
          disabled={digits(phoneInput).length < 10 || searchMut.isPending}
          onClick={() => {
            setSearched(phoneInput);
            setMsg(null);
            setConfirmId(null);
            searchMut.mutate(phoneInput);
          }}
        >
          {searchMut.isPending ? "検索中…" : "確認"}
        </button>
      </div>
      {msg && <p className="mt-3 text-lg font-bold text-[var(--green)]">{msg}</p>}
      {searched !== null && (
        <div className="mt-4 space-y-3">
          {mine.length === 0 && !searchMut.isPending && (
            <p className="text-lg text-[var(--dim)]">この電話番号の今後の予約は、{shop.name}にはありません。</p>
          )}
          {mine.map((b) => {
            return (
              <div key={b.id} className="rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] p-4">
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

function OwnerBookings({ state, shop, ownerPin }: { state: State; shop: Shop; ownerPin: string }) {
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

  // 氏名・電話番号つきの予約一覧は、暗証番号認証後の専用取得でのみ読み込む
  const ownerBookingsQ = useQuery({
    queryKey: ["ownerBookings", shop.id],
    queryFn: () => api.getOwnerBookings({ shopId: shop.id, ownerPin }),
  });
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["state"] });
    void queryClient.invalidateQueries({ queryKey: ["ownerBookings", shop.id] });
  };

  const endDate = range === "today" ? state.today : addDays(state.today, 6);
  const list = (ownerBookingsQ.data?.bookings ?? [])
    .filter(
      (b) =>
        b.status === "booked" &&
        b.date >= state.today &&
        b.date <= endDate,
    )
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  const dates: string[] = [];
  for (const b of list) if (!dates.includes(b.date)) dates.push(b.date);

  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancelMut = useMutation({
    mutationFn: (id: number) => api.cancelBooking({ id, ownerPin }),
    onSuccess: (res) => {
      if (res.ok) {
        setConfirmId(null);
        setCancelError(null);
        invalidateAll();
      } else {
        setCancelError(res.error ?? "取り消せませんでした");
      }
    },
    onError: () => setCancelError("通信に失敗しました"),
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
        invalidateAll();
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

        {cancelError && (
          <p className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] p-4 text-lg font-bold text-[var(--red)]">
            {cancelError}
          </p>
        )}
        {ownerBookingsQ.isPending && (
          <p className="mt-4 text-center text-lg text-[var(--dim)]">予約を読み込んでいます…</p>
        )}
        {ownerBookingsQ.error && (
          <p className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] p-4 text-lg font-bold text-[var(--red)]">
            予約一覧を読み込めませんでした。ロックして入り直してください。
          </p>
        )}
        <div className="mt-4 space-y-5">
          {list.length === 0 && !ownerBookingsQ.isPending && !ownerBookingsQ.error && (
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

function CalendarEdit({ state, shop, ownerPin }: { state: State; shop: Shop; ownerPin: string }) {
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
        ownerPin,
        slug: shop.slug,
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
    onSuccess: (res) => {
      if (res.ok) {
        setRuleMsg("定休日を保存しました");
        invalidate();
      } else {
        setRuleMsg(res.error ?? "保存に失敗しました");
      }
    },
    onError: () => setRuleMsg("保存に失敗しました"),
  });

  const [overrideError, setOverrideError] = useState<string | null>(null);
  const overrideMut = useMutation({
    mutationFn: (kind: "closed" | "open" | "clear") =>
      api.setDayOverride({ shopId: shop.id, ownerPin, date: selected, kind }),
    onSuccess: () => {
      setOverrideError(null);
      invalidate();
    },
    onError: () => setOverrideError("保存に失敗しました。もう一度お試しください"),
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
          {overrideError && (
            <p className="mt-2 text-lg font-bold text-[var(--red)]">{overrideError}</p>
          )}
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

function Settings({
  state,
  shop,
  ownerPin,
  onPinChanged,
  onSlugChanged,
}: {
  state: State;
  shop: Shop;
  ownerPin: string;
  onPinChanged: (shopId: number, newPin: string) => void;
  onSlugChanged: (newSlug: string) => void;
}) {
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState(shop.slug);
  const [name, setName] = useState(shop.name);
  const [address, setAddress] = useState(shop.address);
  const [phone, setPhone] = useState(shop.phone);
  const [openTime, setOpenTime] = useState(shop.openTime);
  const [closeTime, setCloseTime] = useState(shop.closeTime);
  const [slotMinutes, setSlotMinutes] = useState(shop.slotMinutes);
  const [chairs, setChairs] = useState(shop.chairs);
  const [shopMsg, setShopMsg] = useState<string | null>(null);
  const [shopError, setShopError] = useState<string | null>(null);

  const [curPin, setCurPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);

  const changePinMut = useMutation({
    mutationFn: () =>
      api.changeOwnerPin({ shopId: shop.id, currentPin: curPin, newPin }),
    onSuccess: (res) => {
      if (res.ok) {
        onPinChanged(shop.id, newPin);
        setPinMsg("暗証番号を変更しました。次回から新しい暗証番号で入ってください。");
        setPinError(null);
        setCurPin("");
        setNewPin("");
        setNewPin2("");
        invalidate();
      } else {
        setPinError(res.error ?? "変更できませんでした");
        setPinMsg(null);
      }
    },
    onError: () => {
      setPinError("通信に失敗しました。もう一度お試しください");
      setPinMsg(null);
    },
  });

  const pinValid =
    /^\d{4}$/.test(curPin) &&
    /^\d{4}$/.test(newPin) &&
    newPin === newPin2 &&
    !changePinMut.isPending;

  const [editMenuId, setEditMenuId] = useState<number | null>(null);
  const [menuName, setMenuName] = useState("");
  const [menuPrice, setMenuPrice] = useState("");
  const [menuMinutes, setMenuMinutes] = useState("60");
  const [menuMsg, setMenuMsg] = useState<string | null>(null);
  const [confirmDeleteMenu, setConfirmDeleteMenu] = useState<number | null>(null);

  useEffect(() => {
    setSlug(shop.slug);
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

  const slugValid =
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim()) &&
    slug.trim().length >= 2 &&
    slug.trim().length <= 32 &&
    slug.trim() !== "owner" &&
    slug.trim() !== "admin";
  const slugTakenByOther = state.shops.some(
    (s) => s.id !== shop.id && s.slug === slug.trim(),
  );

  const saveShopMut = useMutation({
    mutationFn: () =>
      api.updateShop({
        id: shop.id,
        ownerPin,
        slug: slug.trim(),
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
    onSuccess: (res) => {
      if (res.ok) {
        setShopMsg("お店の設定を保存しました");
        setShopError(null);
        invalidate();
        if (slug.trim() !== shop.slug) onSlugChanged(slug.trim());
      } else {
        setShopError(res.error ?? "保存に失敗しました");
        setShopMsg(null);
      }
    },
    onError: () => {
      setShopError("保存に失敗しました");
      setShopMsg(null);
    },
  });

  const saveMenuMut = useMutation({
    mutationFn: () =>
      api.upsertMenu({
        id: editMenuId,
        shopId: shop.id,
        ownerPin,
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
    mutationFn: (id: number) => api.deleteMenu({ id, shopId: shop.id, ownerPin }),
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
            <label htmlFor="st-slug" className={labelCls}>URL用スラッグ（このお店専用URL）</label>
            <input
              id="st-slug"
              className={inputCls}
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder="例：shop1"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <p className="mt-1 text-base text-[var(--dim)]">
              英小文字・数字・ハイフンで2〜32文字。他のお店と重複できません。
              変えると古いURL（店内QRコードなど）は使えなくなります。
            </p>
            <p className="mt-1 text-base">
              お客さん用：<span className="font-bold">/{slug.trim() || "…"}</span>
              <br />
              店主用：<span className="font-bold">/{slug.trim() || "…"}/owner</span>
            </p>
            {slug.trim().length > 0 && !slugValid && (
              <p className="mt-1 text-lg font-bold text-[var(--red)]">
                スラッグの形式が正しくありません（「owner」「admin」は使えません）。
              </p>
            )}
            {slugValid && slugTakenByOther && (
              <p className="mt-1 text-lg font-bold text-[var(--red)]">
                このスラッグは他のお店で使われています。
              </p>
            )}
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
          {shopError && <p className="text-lg font-bold text-[var(--red)]">{shopError}</p>}
          {shopMsg && <p className="text-lg font-bold text-[var(--green)]">{shopMsg}</p>}
          <button type="button" className={bigBtnCls} disabled={name.trim().length === 0 || !slugValid || slugTakenByOther || saveShopMut.isPending}
            onClick={() => saveShopMut.mutate()}>
            お店の設定を保存する
          </button>
        </div>
      </section>

      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <h3 className="text-xl font-bold">店主画面の暗証番号</h3>
        {shop.pinNeedsSetup ? (
          <p className="mt-2 rounded-[var(--radius)] border-2 border-[var(--red)] bg-[var(--surface-alt)] p-3 text-lg font-bold text-[var(--red)]">
            暗証番号が未設定です。店主画面の初回設定で設定してください。
          </p>
        ) : (
          <p className="mt-1 text-base text-[var(--dim)]">
            店主画面に入るときの4桁の暗証番号を変更できます。
          </p>
        )}
        <div className="mt-3 space-y-4">
          <div>
            <label htmlFor="pin-cur" className={labelCls}>今の暗証番号（4桁）</label>
            <input
              id="pin-cur"
              className={inputCls}
              value={curPin}
              onChange={(e) => setCurPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
              placeholder="数字4桁"
              inputMode="numeric"
              type="password"
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="pin-new" className={labelCls}>新しい暗証番号（4桁）</label>
            <input
              id="pin-new"
              className={inputCls}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
              placeholder="数字4桁"
              inputMode="numeric"
              type="password"
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="pin-new2" className={labelCls}>新しい暗証番号（もう一度）</label>
            <input
              id="pin-new2"
              className={inputCls}
              value={newPin2}
              onChange={(e) => setNewPin2(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
              placeholder="数字4桁"
              inputMode="numeric"
              type="password"
              autoComplete="off"
            />
          </div>
          {newPin2.length === 4 && newPin !== newPin2 && (
            <p className="text-lg font-bold text-[var(--red)]">
              新しい暗証番号が2回で一致していません。
            </p>
          )}
          {pinError && <p className="text-lg font-bold text-[var(--red)]">{pinError}</p>}
          {pinMsg && <p className="text-lg font-bold text-[var(--green)]">{pinMsg}</p>}
          <button
            type="button"
            className={bigBtnCls}
            disabled={!pinValid}
            onClick={() => changePinMut.mutate()}
          >
            暗証番号を変更する
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

// ---------- owner: PIN gate ----------

function PinGate({
  shop,
  onSuccess,
  onBack,
}: {
  shop: Shop;
  onSuccess: (pin: string) => void;
  onBack: () => void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const attempt = async (value: string) => {
    setChecking(true);
    setError(null);
    try {
      const res = await api.verifyOwnerPin({ shopId: shop.id, pin: value });
      if (res.ok) {
        onSuccess(value);
      } else {
        setError("暗証番号が違います。もう一度入力してください。");
        setPin("");
      }
    } catch {
      setError("通信に失敗しました。もう一度お試しください。");
    } finally {
      setChecking(false);
    }
  };

  const pushDigit = (d: string) => {
    if (checking || pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    setError(null);
    if (next.length === 4) void attempt(next);
  };

  const handleInput = (value: string) => {
    const cleaned = value.replace(/[^0-9]/g, "").slice(0, 4);
    setPin(cleaned);
    setError(null);
    if (cleaned.length === 4 && !checking) void attempt(cleaned);
  };

  return (
    <section className="mx-auto max-w-md rounded-[var(--radius)] bg-[var(--surface)] p-5 shadow-sm">
      <h2 className="text-center text-2xl font-bold">店主画面ロック</h2>
      <p className="mt-2 text-center text-lg">
        <span className="font-bold">{shop.name}</span> の店主画面です。
        <br />
        暗証番号（数字4桁）を入力してください。
      </p>
      <div className="mt-5 flex items-center justify-center gap-3" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-6 w-6 rounded-full border-2 ${
              pin.length > i
                ? "border-[var(--accent)] bg-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--surface)]"
            }`}
          />
        ))}
      </div>
      <p className="mt-2 text-center text-base text-[var(--dim)]" role="status">
        {checking ? "確認しています…" : `${pin.length} / 4 桁入力済み`}
      </p>

      {error && (
        <p className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] p-4 text-center text-lg font-bold text-[var(--red)]" role="alert">
          {error}
        </p>
      )}

      <div className="mt-5 grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button
            key={d}
            type="button"
            aria-label={`数字 ${d}`}
            disabled={checking}
            onClick={() => pushDigit(d)}
            className="min-h-16 rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] text-3xl font-bold text-[var(--text)] disabled:opacity-40"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          aria-label="全部消す"
          disabled={checking || pin.length === 0}
          onClick={() => setPin("")}
          className="min-h-16 rounded-[var(--radius)] bg-[var(--surface-alt)] text-lg font-bold text-[var(--text)] disabled:opacity-40"
        >
          消す
        </button>
        <button
          type="button"
          aria-label="数字 0"
          disabled={checking}
          onClick={() => pushDigit("0")}
          className="min-h-16 rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] text-3xl font-bold text-[var(--text)] disabled:opacity-40"
        >
          0
        </button>
        <button
          type="button"
          aria-label="1文字消す"
          disabled={checking || pin.length === 0}
          onClick={() => setPin(pin.slice(0, -1))}
          className="min-h-16 rounded-[var(--radius)] bg-[var(--surface-alt)] text-lg font-bold text-[var(--text)] disabled:opacity-40"
        >
          ← 消す
        </button>
      </div>

      <div className="mt-5">
        <label htmlFor="pin-gate-input" className={labelCls}>
          キーボードで入力する場合
        </label>
        <input
          id="pin-gate-input"
          className={`${inputCls} text-center text-2xl tracking-[0.5em]`}
          value={pin}
          onChange={(e) => handleInput(e.target.value)}
          placeholder="4桁"
          inputMode="numeric"
          type="password"
          autoComplete="off"
          maxLength={4}
        />
      </div>

      <button
        type="button"
        className="mt-6 min-h-14 w-full rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 text-lg font-bold text-[var(--text)]"
        onClick={onBack}
      >
        お客さん画面に戻る
      </button>
    </section>
  );
}

// ---------- owner: first-run PIN setup (no default PIN exists) ----------

function SetupPin({
  shop,
  onSetup,
  onBack,
}: {
  shop: Shop;
  onSetup: (newPin: string) => void;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [newPin, setNewPin] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setupMut = useMutation({
    mutationFn: () => api.setupOwnerPin({ shopId: shop.id, newPin }),
    onSuccess: (res) => {
      if (res.ok) {
        onSetup(newPin);
        void queryClient.invalidateQueries({ queryKey: ["state"] });
      } else {
        setError(res.error ?? "設定できませんでした");
      }
    },
    onError: () => setError("通信に失敗しました。もう一度お試しください"),
  });

  const valid =
    /^\d{4}$/.test(newPin) && newPin === newPin2 && !setupMut.isPending;

  return (
    <section className="mx-auto max-w-md rounded-[var(--radius)] bg-[var(--surface)] p-5 shadow-sm">
      <h2 className="text-center text-2xl font-bold">暗証番号を決めてください</h2>
      <p className="mt-2 text-lg">
        <span className="font-bold">{shop.name}</span> の店主画面には、まだ暗証番号が設定されていません。
        店主ご本人が、新しい暗証番号（数字4桁）を決めてください。
        この番号は店主画面に入るたびに必要です。忘れない番号にしてください。
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="sup-new" className={labelCls}>新しい暗証番号（4桁）</label>
          <input
            id="sup-new"
            className={inputCls}
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
            placeholder="数字4桁"
            inputMode="numeric"
            type="password"
            autoComplete="off"
          />
        </div>
        <div>
          <label htmlFor="sup-new2" className={labelCls}>新しい暗証番号（もう一度）</label>
          <input
            id="sup-new2"
            className={inputCls}
            value={newPin2}
            onChange={(e) => setNewPin2(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
            placeholder="数字4桁"
            inputMode="numeric"
            type="password"
            autoComplete="off"
          />
        </div>
        {newPin2.length === 4 && newPin !== newPin2 && (
          <p className="text-lg font-bold text-[var(--red)]">
            暗証番号が2回で一致していません。
          </p>
        )}
        {error && (
          <p className="rounded-[var(--radius)] bg-[var(--surface-alt)] p-4 text-lg font-bold text-[var(--red)]" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className={bigBtnCls}
          disabled={!valid}
          onClick={() => setupMut.mutate()}
        >
          暗証番号を決めて店主画面へ
        </button>
        <button
          type="button"
          className="min-h-14 w-full rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 text-lg font-bold text-[var(--text)]"
          onClick={onBack}
        >
          お客さん画面に戻る
        </button>
      </div>
    </section>
  );
}

// ---------- install guide (PWA) ----------

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

function InstallGuide({ shop }: { shop: Shop }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const standalone =
    typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true);

  if (standalone || installed) {
    return (
      <section className="mt-5 rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <p className="text-lg font-bold text-[var(--green)]">
          {shop.name}のページはホーム画面に追加済みです。このアイコンからいつでも開けます。
        </p>
      </section>
    );
  }

  return (
    <section className="mt-5 rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
      <h2 className="text-xl font-bold">ホーム画面に追加すると便利です</h2>
      <p className="mt-1 text-base text-[var(--dim)]">
        このページは{shop.name}専用の予約ページです。このまま追加すると、次回からアイコンをタップするだけで
        {shop.name}の予約ができます（店内のQRコードもこのお店専用URLから作られています）。
      </p>
      {deferred && (
        <button
          type="button"
          className={`${bigBtnCls} mt-3`}
          onClick={() => {
            void deferred.prompt();
          }}
        >
          ホーム画面に追加する
        </button>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-[var(--radius)] bg-[var(--surface-alt)] p-3">
          <p className="text-lg font-bold">iPhone（Safari）</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-base">
            <li>下の「共有」ボタン（四角に上矢印）をタップ</li>
            <li>「ホーム画面に追加」を選ぶ</li>
            <li>右上の「追加」をタップ</li>
          </ol>
        </div>
        <div className="rounded-[var(--radius)] bg-[var(--surface-alt)] p-3">
          <p className="text-lg font-bold">Android（Chrome）</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-base">
            <li>右上のメニュー（︙）をタップ</li>
            <li>「ホーム画面に追加」または「アプリをインストール」を選ぶ</li>
            <li>「追加」をタップ</li>
          </ol>
        </div>
      </div>
    </section>
  );
}

// ---------- path routing ----------
//
// 店舗別URLは実パス形式で実現する（Bun サーバー / Workers Static Assets
// ともに SPA フォールバックが効くため、どのパスでも index.html が返る）。
//   /             … 店舗入口（各店へのリンク）
//   /<slug>       … その店舗専用のお客さん用ページ
//   /<slug>/owner … その店舗専用の店主用ページ
//   /admin        … 全体管理ページ（どこからもリンクしない）
// お客さん用ページには店主用ページへの導線を置かない。

type Route =
  | { kind: "entrance" }
  | { kind: "customer"; slug: string }
  | { kind: "owner"; slug: string }
  | { kind: "admin" }
  | { kind: "unknown"; slug: string };

function parseRoute(): Route {
  const parts = window.location.pathname.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return { kind: "entrance" };
  const slug = parts[0] ?? "";
  // 「admin」はスラッグの予約語なので、店舗スラッグと衝突しない
  if (parts.length === 1 && slug === "admin") return { kind: "admin" };
  if (parts.length === 1) return { kind: "customer", slug };
  if (parts.length === 2 && parts[1] === "owner") return { kind: "owner", slug };
  return { kind: "unknown", slug };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  useEffect(() => {
    const onChange = () => setRoute(parseRoute());
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return route;
}

function navigateTo(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function ShopInfoCard({ shop, showSetupHint = false }: { shop: Shop; showSetupHint?: boolean }) {
  return (
    <div className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
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
        {showSetupHint && !shop.address && !shop.phone && (
          <p className="text-base text-[var(--dim)]">
            住所・電話番号は店主画面の「設定」から登録できます。
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- admin (全体管理) ----------
//
// /admin 専用ページ。入口・お客さん用・店主用のどこにもリンクは置かない。
// 管理者パスワードはサーバー側でハッシュ保存され、既知の初期パスワードは
// 無い。未設定の間だけ、最初に開いた管理者本人が設定できる。

const ADMIN_STORAGE_KEY = "barber-admin-password";

function loadAdminPassword(): string | null {
  try {
    const v = window.sessionStorage.getItem(ADMIN_STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function AdminSetup({ onSetup }: { onSetup: (pw: string) => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: () => api.setupAdminPassword({ newPassword: pw }),
    onSuccess: (res) => {
      if (res.ok) onSetup(pw);
      else setError(res.error ?? "設定できませんでした");
    },
    onError: () => setError("通信に失敗しました。もう一度お試しください"),
  });
  const valid = pw.length >= 6 && pw === pw2 && !mut.isPending;
  return (
    <section className="mx-auto max-w-md rounded-[var(--radius)] bg-[var(--surface)] p-5 shadow-sm">
      <h2 className="text-center text-2xl font-bold">管理者パスワードを設定</h2>
      <p className="mt-2 text-base text-[var(--dim)]">
        このページは全体管理用です。まだ管理者パスワードが設定されていません。管理者ご本人が新しいパスワード（6文字以上）を決めてください。パスワードはハッシュ化して保存され、平文では保存されません。
      </p>
      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="admin-setup-pw" className={labelCls}>新しい管理者パスワード（6文字以上）</label>
          <input id="admin-setup-pw" type="password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" placeholder="6文字以上" />
        </div>
        <div>
          <label htmlFor="admin-setup-pw2" className={labelCls}>パスワード（もう一度）</label>
          <input id="admin-setup-pw2" type="password" className={inputCls} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" placeholder="もう一度入力" />
        </div>
        {pw2.length > 0 && pw !== pw2 && <p className="text-lg font-bold text-[var(--red)]">パスワードが一致していません。</p>}
        {pw.length > 0 && pw.length < 6 && <p className="text-lg font-bold text-[var(--red)]">パスワードは6文字以上にしてください。</p>}
        {error && <p className="rounded-[var(--radius)] bg-[var(--surface-alt)] p-4 text-lg font-bold text-[var(--red)]" role="alert">{error}</p>}
        <button type="button" className={bigBtnCls} disabled={!valid} onClick={() => mut.mutate()}>
          {mut.isPending ? "設定しています…" : "パスワードを設定して管理画面へ"}
        </button>
      </div>
    </section>
  );
}

function AdminLogin({ onLogin }: { onLogin: (pw: string) => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const attempt = async () => {
    if (!pw) return;
    setChecking(true);
    setError(null);
    try {
      const res = await api.verifyAdminPassword({ password: pw });
      if (res.ok) onLogin(pw);
      else {
        setError("パスワードが違います。もう一度入力してください。");
        setPw("");
      }
    } catch {
      setError("通信に失敗しました。もう一度お試しください。");
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className="mx-auto max-w-md rounded-[var(--radius)] bg-[var(--surface)] p-5 shadow-sm">
      <h2 className="text-center text-2xl font-bold">管理者ログイン</h2>
      <p className="mt-2 text-center text-base text-[var(--dim)]">全体管理ページです。管理者パスワードを入力してください。</p>
      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="admin-login-pw" className={labelCls}>管理者パスワード</label>
          <input id="admin-login-pw" type="password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" placeholder="パスワード" onKeyDown={(e) => { if (e.key === "Enter") void attempt(); }} />
        </div>
        {error && <p className="rounded-[var(--radius)] bg-[var(--surface-alt)] p-4 text-lg font-bold text-[var(--red)]" role="alert">{error}</p>}
        <button type="button" className={bigBtnCls} disabled={!pw || checking} onClick={() => void attempt()}>
          {checking ? "確認しています…" : "ログイン"}
        </button>
      </div>
    </section>
  );
}

function AdminShopSlugEditor({ shop, adminPassword }: { shop: Shop; adminPassword: string }) {
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState(shop.slug);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setSlug(shop.slug); }, [shop.slug]);
  const slugTrim = slug.trim();
  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugTrim) && slugTrim.length >= 2 && slugTrim.length <= 32 && slugTrim !== "owner" && slugTrim !== "admin";
  const mut = useMutation({
    mutationFn: () => api.adminUpdateSlug({ adminPassword, shopId: shop.id, slug: slugTrim }),
    onSuccess: (res) => {
      if (res.ok) {
        setMsg("スラッグを変更しました");
        setError(null);
        void queryClient.invalidateQueries({ queryKey: ["state"] });
        void queryClient.invalidateQueries({ queryKey: ["adminShops"] });
      } else {
        setError(res.error ?? "変更できませんでした");
        setMsg(null);
      }
    },
    onError: () => setError("通信に失敗しました"),
  });
  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <label htmlFor={`admin-slug-${shop.id}`} className={labelCls}>スラッグを変更</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input id={`admin-slug-${shop.id}`} className={inputCls} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="例：shop1" aria-label={`${shop.name}のスラッグ`} />
        <button type="button" className="min-h-14 shrink-0 rounded-[var(--radius)] bg-[var(--accent)] px-5 text-lg font-bold text-[var(--accent-text)] disabled:opacity-40" disabled={!valid || slugTrim === shop.slug || mut.isPending} onClick={() => mut.mutate()}>
          {mut.isPending ? "保存中…" : "スラッグを保存"}
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--dim)]">英小文字・数字・ハイフンで2〜32文字。他店と重複不可、「owner」「admin」は使用不可。変更すると古いURLは使えなくなります。</p>
      {!valid && slugTrim.length > 0 && <p className="mt-1 text-base font-bold text-[var(--red)]">スラッグの形式が正しくありません。</p>}
      {error && <p className="mt-1 text-base font-bold text-[var(--red)]">{error}</p>}
      {msg && <p className="mt-1 text-base font-bold text-[var(--green)]">{msg}</p>}
    </div>
  );
}

function AdminDashboard({ adminPassword, onLogout, onPasswordChanged }: { adminPassword: string; onLogout: () => void; onPasswordChanged: (newPw: string) => void }) {
  const queryClient = useQueryClient();
  const shopsQ = useQuery({ queryKey: ["adminShops"], queryFn: () => api.adminListShops({ adminPassword }) });
  const shops = shopsQ.data?.shops ?? [];

  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [createMsg, setCreateMsg] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const newSlugTrim = newSlug.trim();
  const newSlugValid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newSlugTrim) && newSlugTrim.length >= 2 && newSlugTrim.length <= 32 && newSlugTrim !== "owner" && newSlugTrim !== "admin";
  const slugTaken = shops.some((s) => s.slug === newSlugTrim);

  const createMut = useMutation({
    mutationFn: () => api.adminCreateShop({ adminPassword, name: newName.trim(), slug: newSlugTrim, address: newAddress.trim(), phone: newPhone.trim() }),
    onSuccess: (res) => {
      if (res.ok) {
        setCreateMsg(`店舗「${newName.trim()}」を追加しました（スラッグ：${newSlugTrim}）`);
        setCreateError(null);
        setNewName("");
        setNewSlug("");
        setNewAddress("");
        setNewPhone("");
        void queryClient.invalidateQueries({ queryKey: ["state"] });
        void queryClient.invalidateQueries({ queryKey: ["adminShops"] });
      } else {
        setCreateError(res.error ?? "作成できませんでした");
        setCreateMsg(null);
      }
    },
    onError: () => setCreateError("通信に失敗しました"),
  });

  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const changePwMut = useMutation({
    mutationFn: () => api.changeAdminPassword({ currentPassword: curPw, newPassword: newPw }),
    onSuccess: (res) => {
      if (res.ok) {
        onPasswordChanged(newPw);
        setPwMsg("管理者パスワードを変更しました。次回から新しいパスワードでログインしてください。");
        setPwError(null);
        setCurPw("");
        setNewPw("");
        setNewPw2("");
      } else {
        setPwError(res.error ?? "変更できませんでした");
        setPwMsg(null);
      }
    },
    onError: () => setPwError("通信に失敗しました"),
  });
  const pwValid = curPw.length > 0 && newPw.length >= 6 && newPw === newPw2 && !changePwMut.isPending;

  return (
    <div className="space-y-8 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">全体管理（admin）</h1>
          <p className="mt-1 text-base text-[var(--dim)]">店舗の追加とスラッグ管理を行います。店舗の削除はできません。</p>
        </div>
        <button type="button" className="min-h-12 rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 text-lg font-bold" onClick={onLogout} aria-label="管理者ログアウト">
          ログアウト
        </button>
      </div>

      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <h2 className="text-2xl font-bold">店舗一覧</h2>
        {shopsQ.isPending && <p className="mt-3 text-lg text-[var(--dim)]">読み込んでいます…</p>}
        {shopsQ.error && <p className="mt-3 text-lg font-bold text-[var(--red)]">店舗一覧を読み込めませんでした。ログアウトして入り直してください。</p>}
        <div className="mt-4 space-y-4">
          {shops.map((s) => (
            <article key={s.id} className="rounded-[var(--radius)] border-2 border-[var(--border)] p-4" aria-label={`${s.name}の情報`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="text-2xl font-bold">{s.name}</h3>
                <span className={`rounded-full px-3 py-1 text-sm font-bold ${s.pinNeedsSetup ? "bg-[var(--surface-alt)] text-[var(--red)]" : "bg-[var(--surface-alt)] text-[var(--green)]"}`}>
                  店主暗証番号：{s.pinNeedsSetup ? "未設定" : "設定済み"}
                </span>
              </div>
              <dl className="mt-3 space-y-2 text-base">
                <div className="flex flex-col sm:flex-row sm:gap-2"><dt className="shrink-0 font-bold">スラッグ</dt><dd className="font-mono">{s.slug}</dd></div>
                <div className="flex flex-col sm:flex-row sm:gap-2"><dt className="shrink-0 font-bold">お客さん用URL</dt><dd className="break-all font-mono">/{s.slug}</dd></div>
                <div className="flex flex-col sm:flex-row sm:gap-2"><dt className="shrink-0 font-bold">店主用URL</dt><dd className="break-all font-mono">/{s.slug}/owner</dd></div>
                <div className="flex flex-col sm:flex-row sm:gap-2"><dt className="shrink-0 font-bold">営業時間</dt><dd>{s.openTime}〜{s.closeTime}／枠{s.slotMinutes}分／椅子{s.chairs}台</dd></div>
                {s.address && <div className="flex flex-col sm:flex-row sm:gap-2"><dt className="shrink-0 font-bold">住所</dt><dd>{s.address}</dd></div>}
                {s.phone && <div className="flex flex-col sm:flex-row sm:gap-2"><dt className="shrink-0 font-bold">電話</dt><dd>{s.phone}</dd></div>}
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <a href={`/${s.slug}`} className="min-h-11 rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 py-2 text-base font-bold" aria-label={`${s.name}のお客さん用ページを開く`}>お客さん用を開く</a>
                <a href={`/${s.slug}/owner`} className="min-h-11 rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 py-2 text-base font-bold" aria-label={`${s.name}の店主用ページを開く`}>店主用を開く</a>
              </div>
              <AdminShopSlugEditor shop={s} adminPassword={adminPassword} />
            </article>
          ))}
          {!shopsQ.isPending && shops.length === 0 && <p className="text-lg text-[var(--dim)]">店舗がありません。下のフォームから追加できます。</p>}
        </div>
      </section>

      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <h2 className="text-2xl font-bold">店舗を追加</h2>
        <p className="mt-1 text-base text-[var(--dim)]">店名とスラッグが必須です。初期設定は営業時間09:00–19:00、枠30分、椅子1台、定休日は月曜＋第2・第3火曜、デフォルトメニュー6種が入ります。店主暗証番号は未設定で作られ、店主本人が後で初回設定します。</p>
        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="admin-new-name" className={labelCls}>店名（必須）</label>
            <input id="admin-new-name" className={inputCls} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="例：○○理容室" />
          </div>
          <div>
            <label htmlFor="admin-new-slug" className={labelCls}>スラッグ（必須）</label>
            <input id="admin-new-slug" className={inputCls} value={newSlug} onChange={(e) => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="例：shop3" autoComplete="off" autoCapitalize="none" spellCheck={false} />
            <p className="mt-1 text-sm text-[var(--dim)]">お客さん用：/{newSlugTrim || "…"} ／ 店主用：/{newSlugTrim || "…"}/owner</p>
            {newSlugTrim.length > 0 && !newSlugValid && <p className="mt-1 text-base font-bold text-[var(--red)]">スラッグの形式が正しくありません（「owner」「admin」は使えません）。</p>}
            {newSlugValid && slugTaken && <p className="mt-1 text-base font-bold text-[var(--red)]">このスラッグは既に使われています。</p>}
          </div>
          <div>
            <label htmlFor="admin-new-address" className={labelCls}>住所（任意）</label>
            <input id="admin-new-address" className={inputCls} value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="例：東京都○○区…" />
          </div>
          <div>
            <label htmlFor="admin-new-phone" className={labelCls}>電話番号（任意）</label>
            <input id="admin-new-phone" className={inputCls} value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="例：03-1234-5678" inputMode="tel" />
          </div>
          {createError && <p className="text-lg font-bold text-[var(--red)]" role="alert">{createError}</p>}
          {createMsg && <p className="text-lg font-bold text-[var(--green)]" role="status">{createMsg}</p>}
          <button type="button" className={bigBtnCls} disabled={newName.trim().length === 0 || !newSlugValid || slugTaken || createMut.isPending} onClick={() => createMut.mutate()}>
            {createMut.isPending ? "追加しています…" : "店舗を追加する"}
          </button>
        </div>
      </section>

      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <h2 className="text-2xl font-bold">管理者パスワードの変更</h2>
        <p className="mt-1 text-base text-[var(--dim)]">変更には今のパスワードの照合が必要です。パスワードはハッシュ化して保存されます。</p>
        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="admin-pw-cur" className={labelCls}>今のパスワード</label>
            <input id="admin-pw-cur" type="password" className={inputCls} value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" />
          </div>
          <div>
            <label htmlFor="admin-pw-new" className={labelCls}>新しいパスワード（6文字以上）</label>
            <input id="admin-pw-new" type="password" className={inputCls} value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
          </div>
          <div>
            <label htmlFor="admin-pw-new2" className={labelCls}>新しいパスワード（もう一度）</label>
            <input id="admin-pw-new2" type="password" className={inputCls} value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" />
          </div>
          {newPw2.length > 0 && newPw !== newPw2 && <p className="text-lg font-bold text-[var(--red)]">新しいパスワードが一致していません。</p>}
          {newPw.length > 0 && newPw.length < 6 && <p className="text-lg font-bold text-[var(--red)]">新しいパスワードは6文字以上にしてください。</p>}
          {pwError && <p className="text-lg font-bold text-[var(--red)]">{pwError}</p>}
          {pwMsg && <p className="text-lg font-bold text-[var(--green)]">{pwMsg}</p>}
          <button type="button" className={bigBtnCls} disabled={!pwValid} onClick={() => changePwMut.mutate()}>
            パスワードを変更する
          </button>
        </div>
      </section>
    </div>
  );
}

function AdminPage() {
  const statusQ = useQuery({ queryKey: ["adminStatus"], queryFn: () => api.getAdminStatus({}) });
  const [adminPassword, setAdminPassword] = useState<string | null>(() => loadAdminPassword());
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      if (adminPassword) window.sessionStorage.setItem(ADMIN_STORAGE_KEY, adminPassword);
      else window.sessionStorage.removeItem(ADMIN_STORAGE_KEY);
    } catch { /* 保存できなくても動作は続ける */ }
  }, [adminPassword]);

  useEffect(() => {
    if (!adminPassword) { setVerified(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.verifyAdminPassword({ password: adminPassword });
        if (!cancelled) {
          setVerified(res.ok);
          if (!res.ok) setAdminPassword(null);
        }
      } catch {
        if (!cancelled) setVerified(false);
      }
    })();
    return () => { cancelled = true; };
  }, [adminPassword]);

  if (statusQ.isPending) return <p className="py-16 text-center text-xl">読み込んでいます…</p>;
  if (statusQ.error) return <p className="py-16 text-center text-xl font-bold text-[var(--red)]">読み込みに失敗しました</p>;
  const needsSetup = statusQ.data?.needsSetup ?? false;

  if (needsSetup) {
    return (
      <div className="pt-6">
        <AdminSetup onSetup={(pw) => { setAdminPassword(pw); setVerified(true); }} />
      </div>
    );
  }

  if (!adminPassword || verified === false) {
    return (
      <div className="pt-6">
        <AdminLogin onLogin={(pw) => { setAdminPassword(pw); setVerified(true); }} />
      </div>
    );
  }

  if (verified === null) return <p className="py-16 text-center text-xl">確認しています…</p>;

  return (
    <AdminDashboard
      adminPassword={adminPassword}
      onLogout={() => { setAdminPassword(null); setVerified(null); }}
      onPasswordChanged={(newPw) => setAdminPassword(newPw)}
    />
  );
}

// ---------- root ----------

const OWNER_PIN_STORAGE_KEY = "barber-owner-pins";

function loadOwnerPins(): Record<number, string> {
  try {
    const raw = window.sessionStorage.getItem(OWNER_PIN_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && /^\d{4}$/.test(v)) out[Number(k)] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function App() {
  const stateQ = useQuery({ queryKey: ["state"], queryFn: () => api.getState({}) });
  const route = useRoute();
  const [ownerTab, setOwnerTab] = useState<"bookings" | "calendar" | "settings">("bookings");
  // 店舗ごとに認証済みの暗証番号（このタブを開いている間だけ保持）
  const [ownerPins, setOwnerPins] = useState<Record<number, string>>(loadOwnerPins);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(OWNER_PIN_STORAGE_KEY, JSON.stringify(ownerPins));
    } catch {
      // 保存できなくても動作は続ける
    }
  }, [ownerPins]);

  const state = stateQ.data;
  const routeSlug =
    route.kind === "customer" || route.kind === "owner" || route.kind === "unknown"
      ? route.slug
      : null;
  const shop =
    state && routeSlug !== null
      ? (state.shops.find((s) => s.slug === routeSlug) ?? null)
      : null;
  const ownerPin = shop ? ownerPins[shop.id] : undefined;
  const ownerAuthed = ownerPin !== undefined;

  // 全体管理ページ（/admin）は店舗の状態に依存しない専用画面。
  // 入口・お客さん用・店主用のどこにもリンクは置いていない。
  if (route.kind === "admin") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-2xl px-4 pb-16">
          <AdminPage />
        </main>
      </div>
    );
  }

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

        {state && route.kind === "entrance" && (
          <div className="pt-6">
            <h1 className="text-3xl font-bold">お店を選んでください</h1>
            <p className="mt-2 text-lg text-[var(--dim)]">
              ご予約のお店をタップすると、そのお店専用の予約ページが開きます。
            </p>
            <div className="mt-5 space-y-4">
              {state.shops.map((s) => (
                <a
                  key={s.id}
                  href={`/${s.slug}`}
                  className="block rounded-[var(--radius)] border-2 border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm"
                  aria-label={`${s.name}の予約ページを開く`}
                >
                  <p className="text-3xl font-bold">{s.name}</p>
                  <div className="mt-2 space-y-1 text-lg">
                    <p>
                      営業時間：{s.openTime}〜{s.closeTime}
                    </p>
                    <p>定休日：{closedSummary(s)}</p>
                    {s.address && <p>住所：{s.address}</p>}
                    {s.phone && <p>電話：{s.phone}</p>}
                  </div>
                  <p className="mt-4 min-h-14 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-3 text-center text-xl font-bold text-[var(--accent-text)]">
                    このお店で予約する
                  </p>
                </a>
              ))}
              {state.shops.length === 0 && (
                <p className="text-lg text-[var(--dim)]">お店が登録されていません。</p>
              )}
            </div>
            <p className="mt-6 text-base text-[var(--dim)]">
              ホーム画面への追加は、各お店の予約ページを開いてから行ってください。お店ごとに専用のページがあります。
            </p>
          </div>
        )}

        {state && route.kind !== "entrance" && shop === null && (
          <div className="py-16 text-center">
            <p className="text-2xl font-bold">そのURLのお店は見つかりませんでした</p>
            <p className="mt-3 text-lg text-[var(--dim)]">
              URLが変わっているか、入力が間違っている可能性があります。下のボタンからお店を選び直してください。
            </p>
            <a
              href="/"
              className={`${bigBtnCls} mt-6 block py-3 text-center`}
              aria-label="店舗入口ページへ移動する"
            >
              店舗入口へ
            </a>
          </div>
        )}

        {state && shop && route.kind === "customer" && (
          <>
            <div className="pt-4">
              <ShopInfoCard shop={shop} />
            </div>
            <div className="mt-6">
              <BookingFlow key={`bf-${shop.id}`} state={state} shop={shop} />
              <MyBookings key={`mb-${shop.id}`} shop={shop} />
              <InstallGuide shop={shop} />
            </div>
            <p className="mt-8 text-center">
              <a href="/" className="text-base font-bold text-[var(--accent)] underline">
                ほかのお店を選ぶ（店舗入口へ）
              </a>
            </p>
          </>
        )}

        {state && shop && route.kind === "owner" && (
          <>
            <div className="pt-4">
              <ShopInfoCard shop={shop} showSetupHint />
            </div>
            <div className="mt-6">
              {shop.pinNeedsSetup ? (
                <SetupPin
                  key={`sup-${shop.id}`}
                  shop={shop}
                  onSetup={(pin) =>
                    setOwnerPins((prev) => ({ ...prev, [shop.id]: pin }))
                  }
                  onBack={() => navigateTo("/")}
                />
              ) : !ownerAuthed || ownerPin === undefined ? (
                <PinGate
                  key={`pin-${shop.id}`}
                  shop={shop}
                  onSuccess={(pin) =>
                    setOwnerPins((prev) => ({ ...prev, [shop.id]: pin }))
                  }
                  onBack={() => navigateTo("/")}
                />
              ) : (
                <>
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <p className="text-lg font-bold">
                      {shop.name} の店主画面
                    </p>
                    <button
                      type="button"
                      className="min-h-12 shrink-0 rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 text-lg font-bold"
                      onClick={() =>
                        setOwnerPins((prev) => {
                          const next = { ...prev };
                          delete next[shop.id];
                          return next;
                        })
                      }
                    >
                      ロックする
                    </button>
                  </div>
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
                    <OwnerBookings key={`ob-${shop.id}`} state={state} shop={shop} ownerPin={ownerPin} />
                  )}
                  {ownerTab === "calendar" && (
                    <CalendarEdit key={`ce-${shop.id}`} state={state} shop={shop} ownerPin={ownerPin} />
                  )}
                  {ownerTab === "settings" && (
                    <Settings
                      key={`st-${shop.id}`}
                      state={state}
                      shop={shop}
                      ownerPin={ownerPin}
                      onPinChanged={(id, newPin) =>
                        setOwnerPins((prev) => ({ ...prev, [id]: newPin }))
                      }
                      onSlugChanged={(newSlug) => navigateTo(`/${newSlug}/owner`)}
                    />
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
