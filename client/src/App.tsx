// 営業日カレンダー — client app (React SPA, real-path routing).
//
// Routes:
//   /                サービス紹介ランディング
//   /signup          新規登録（ID + パスワード）
//   /login           ログイン
//   /admin           運営用・全体管理（導線なし）
//   /<slug>          公開カレンダー（誰でも閲覧可）
//   /<slug>/edit     編集画面（ログイン or 編集リンクのセッションが必要）
//   /<slug>/<uuid>   秘密編集リンク（照合して /<slug>/edit へ）
//
// デザイン方針: 配色・余白・文字の美しさで魅せる。お店のテーマ
// （data-theme + CSS変数）が公開・編集の両画面に反映される。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiResponse } from "./api";
import { SafeAreaTopScrim } from "./SafeArea";

// ---------- types ----------

type CalendarData = ApiResponse<typeof api, "getCalendar">;
type Override = CalendarData["overrides"][number];

type CalRules = {
  closedWeekdays: number[];
  nthClosures: { nth: number; weekday: number }[];
};

// ---------- date helpers ----------

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const NTH_LABELS = ["", "第1", "第2", "第3", "第4", "第5"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function todayJST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

function nowTimeJST(): string {
  return new Date().toLocaleTimeString("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ymOf(dateStr: string): string {
  return dateStr.slice(0, 7);
}

function shiftYM(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y as number, (m as number) - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function dateLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAY_LABELS[d.getDay()]}）`;
}

function isOpenDay(rules: CalRules, overrides: Map<string, Override>, date: string): boolean {
  const ov = overrides.get(date);
  if (ov) return ov.kind === "open";
  const d = new Date(`${date}T00:00:00`);
  const weekday = d.getDay();
  if (rules.closedWeekdays.includes(weekday)) return false;
  const nth = Math.ceil(d.getDate() / 7);
  if (rules.nthClosures.some((c) => c.nth === nth && c.weekday === weekday)) return false;
  return true;
}

function effectiveHours(
  shop: { openTime: string; closeTime: string },
  override: Override | undefined,
): { open: string; close: string; custom: boolean } {
  if (override?.hours) {
    const [open = shop.openTime, close = shop.closeTime] = override.hours.split("-");
    return { open, close, custom: true };
  }
  return { open: shop.openTime, close: shop.closeTime, custom: false };
}

function closedRuleText(shop: CalRules): string {
  const parts: string[] = [];
  if (shop.closedWeekdays.length > 0) {
    parts.push(`毎週${shop.closedWeekdays.map((w) => `${WEEKDAY_LABELS[w]}曜日`).join("・")}`);
  }
  for (const c of shop.nthClosures) {
    parts.push(`${NTH_LABELS[c.nth]}${WEEKDAY_LABELS[c.weekday]}曜日`);
  }
  return parts.length > 0 ? parts.join("、") : "なし";
}

function relativeUpdated(iso: string | null, today: string): string | null {
  if (!iso) return null;
  const updatedDate = new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
  const diffDays = Math.round(
    (new Date(`${today}T00:00:00`).getTime() - new Date(`${updatedDate}T00:00:00`).getTime()) /
      86400000,
  );
  const d = new Date(iso);
  const datePart = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (diffDays <= 0) return `${datePart}（今日）更新`;
  if (diffDays === 1) return `${datePart}（昨日）更新`;
  if (diffDays <= 30) return `${datePart}（${diffDays}日前）更新`;
  return `${datePart} 更新`;
}

// ---------- shared UI ----------

const THEME_OPTIONS: { key: string; label: string; accent: string; bg: string }[] = [
  { key: "standard", label: "スタンダード", accent: "#1f3350", bg: "#f6f3ec" },
  { key: "warm", label: "ウォーム", accent: "#a84e28", bg: "#faf2e9" },
  { key: "sakura", label: "さくら", accent: "#b84f6e", bg: "#fdf3f4" },
  { key: "forest", label: "フォレスト", accent: "#2e6b4f", bg: "#f1f5ef" },
  { key: "ocean", label: "オーシャン", accent: "#1565a0", bg: "#eef4f9" },
  { key: "mono", label: "モノ", accent: "#26262c", bg: "#f3f3f4" },
];

function Card(props: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-[28px] border p-5 sm:p-6 ${props.className ?? ""}`}
      style={{
        background: "var(--surface)",
        borderColor: "var(--border)",
        boxShadow: "0 12px 40px rgba(30, 25, 15, 0.06)",
      }}
    >
      {props.children}
    </section>
  );
}

function PrimaryButton(props: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled}
      className="min-h-14 w-full rounded-2xl px-6 text-base font-semibold tracking-wide transition-opacity disabled:opacity-40"
      style={{ background: "var(--accent)", color: "var(--accent-text)" }}
    >
      {props.children}
    </button>
  );
}

function GhostButton(props: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className="min-h-14 w-full rounded-2xl border px-6 text-base font-semibold tracking-wide disabled:opacity-40"
      style={{
        background: "var(--surface)",
        borderColor: "var(--border)",
        color: "var(--text)",
      }}
    >
      {props.children}
    </button>
  );
}

function TextInput(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span
        className="mb-2 block text-sm font-semibold tracking-wide"
        style={{ color: "var(--dim)" }}
      >
        {props.label}
      </span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        className="min-h-14 w-full rounded-2xl border px-4 text-base outline-none"
        style={{
          background: "var(--surface)",
          borderColor: "var(--border)",
          color: "var(--text)",
        }}
      />
      {props.hint ? (
        <span className="mt-2 block text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
          {props.hint}
        </span>
      ) : null}
    </label>
  );
}

function ErrorBox(props: { message: string | null }) {
  if (!props.message) return null;
  return (
    <p
      className="rounded-2xl px-4 py-3 text-sm leading-relaxed"
      style={{ background: "var(--closed-bg)", color: "var(--closed)" }}
      role="alert"
    >
      {props.message}
    </p>
  );
}

// ---------- calendar grid (public & edit shared) ----------

function buildMonthCells(ym: string): (string | null)[] {
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(y as number, (m as number) - 1, 1);
  const daysInMonth = new Date(y as number, m as number, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${ym}-${pad(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function CalendarGrid(props: {
  rules: CalRules;
  overrides: Map<string, Override>;
  yearMonth: string;
  today: string;
  selected: string | null;
  onSelect?: (date: string) => void;
}) {
  const cells = useMemo(() => buildMonthCells(props.yearMonth), [props.yearMonth]);
  return (
    <div>
      <div className="mb-2 grid grid-cols-7">
        {WEEKDAY_LABELS.map((w, i) => (
          <div
            key={w}
            className="pb-1 text-center text-xs font-semibold tracking-widest"
            style={{
              color: i === 0 ? "var(--closed)" : i === 6 ? "var(--accent)" : "var(--dim)",
            }}
          >
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((date, i) => {
          if (!date) return <div key={`e-${i}`} />;
          const open = isOpenDay(props.rules, props.overrides, date);
          const ov = props.overrides.get(date);
          const isToday = date === props.today;
          const isSelected = date === props.selected;
          const dayNum = Number(date.slice(8));
          const style: React.CSSProperties = {};
          if (isSelected) {
            style.background = "var(--accent)";
            style.color = "var(--accent-text)";
          } else if (!open) {
            style.background = "var(--closed-bg)";
            style.color = "var(--closed)";
          } else {
            style.color = "var(--text)";
          }
          if (isToday && !isSelected) {
            style.boxShadow = "inset 0 0 0 2px var(--accent)";
          }
          const inner = (
            <>
              <span className="tnum text-base leading-none font-semibold">{dayNum}</span>
              <span className="mt-1 flex h-3 items-center justify-center gap-1">
                {!open ? (
                  <span className="text-[10px] leading-none font-semibold tracking-widest">休</span>
                ) : ov?.note ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: isSelected ? "var(--accent-text)" : "var(--accent)" }}
                  />
                ) : ov ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full opacity-50"
                    style={{ background: isSelected ? "var(--accent-text)" : "var(--dim)" }}
                  />
                ) : null}
              </span>
            </>
          );
          const cls = "flex min-h-[52px] flex-col items-center justify-center rounded-2xl py-1.5";
          return props.onSelect ? (
            <button
              key={date}
              type="button"
              className={cls}
              style={style}
              onClick={() => props.onSelect?.(date)}
              aria-label={`${dateLabel(date)} ${open ? "営業日" : "休業日"}`}
            >
              {inner}
            </button>
          ) : (
            <div key={date} className={cls} style={style}>
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthNav(props: { yearMonth: string; onChange: (ym: string) => void }) {
  const [y, m] = props.yearMonth.split("-").map(Number);
  return (
    <div className="mb-4 flex items-center justify-between">
      <button
        type="button"
        aria-label="前の月"
        className="flex h-12 w-12 items-center justify-center rounded-full text-2xl"
        style={{ background: "var(--surface-alt)", color: "var(--text)" }}
        onClick={() => props.onChange(shiftYM(props.yearMonth, -1))}
      >
        ‹
      </button>
      <h2 className="tnum text-lg font-bold tracking-wide">
        {y}年 {m}月
      </h2>
      <button
        type="button"
        aria-label="次の月"
        className="flex h-12 w-12 items-center justify-center rounded-full text-2xl"
        style={{ background: "var(--surface-alt)", color: "var(--text)" }}
        onClick={() => props.onChange(shiftYM(props.yearMonth, 1))}
      >
        ›
      </button>
    </div>
  );
}

// ---------- public calendar (/<slug>) ----------

function PublicCalendarPage(props: { slug: string }) {
  const today = todayJST();
  const [yearMonth, setYearMonth] = useState(ymOf(today));
  const [selected, setSelected] = useState<string>(today);
  const query = useQuery({
    queryKey: ["calendar", props.slug, yearMonth],
    queryFn: () => api.getCalendar({ slug: props.slug, yearMonth }),
  });

  const shop = query.data?.shop ?? null;
  const overrides = useMemo(() => {
    const map = new Map<string, Override>();
    for (const o of query.data?.overrides ?? []) map.set(o.date, o);
    return map;
  }, [query.data]);

  useEffect(() => {
    if (ymOf(selected) !== yearMonth) {
      setSelected(yearMonth === ymOf(today) ? today : `${yearMonth}-01`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearMonth]);

  if (query.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center" style={{ background: "var(--bg)" }}>
        <p style={{ color: "var(--dim)" }}>読み込み中…</p>
      </div>
    );
  }

  if (!query.data?.found || !shop) {
    return (
      <div
        className="flex min-h-dvh items-center justify-center px-6"
        style={{ background: "var(--bg)", color: "var(--text)" }}
      >
        <div className="max-w-md text-center">
          <h1 className="font-display text-2xl font-bold">カレンダーが見つかりません</h1>
          <p className="mt-4 leading-relaxed" style={{ color: "var(--dim)" }}>
            このURLのカレンダーは存在しないか、削除されています。お店で配布されたリンクをもう一度ご確認ください。
          </p>
          <a
            href="/"
            className="mt-8 inline-block rounded-2xl px-6 py-3 font-semibold"
            style={{ background: "var(--accent)", color: "var(--accent-text)" }}
          >
            トップへ
          </a>
        </div>
      </div>
    );
  }

  const todayOpen = isOpenDay(shop, overrides, today);
  const todayOv = overrides.get(today);
  const todayHours = effectiveHours(shop, todayOv);
  const now = nowTimeJST();
  const nowOpen = todayOpen && now >= todayHours.open && now < todayHours.close;
  const selectedOv = overrides.get(selected);
  const selectedOpen = isOpenDay(shop, overrides, selected);
  const selectedHours = effectiveHours(shop, selectedOv);
  const updatedText = relativeUpdated(shop.updatedAt, today);

  const badge = !todayOpen
    ? { text: "本日は休業日です", color: "var(--closed)", bg: "var(--closed-bg)", dot: "var(--closed)" }
    : nowOpen
      ? { text: "ただいま営業中です", color: "var(--open)", bg: "var(--accent-soft)", dot: "var(--open)" }
      : now < todayHours.open
        ? {
            text: `本日は営業日です（${todayHours.open}から）`,
            color: "var(--text)",
            bg: "var(--accent-soft)",
            dot: "var(--open)",
          }
        : {
            text: "本日の営業は終了しました",
            color: "var(--dim)",
            bg: "var(--surface-alt)",
            dot: "var(--dim)",
          };

  return (
    <div data-theme={shop.theme} style={{ background: "var(--bg)", color: "var(--text)" }}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto min-h-dvh w-full max-w-xl px-5 pb-16">
        {/* ヘッダー */}
        <header className="pt-12 pb-8 text-center">
          <p
            className="text-xs font-semibold tracking-[0.35em]"
            style={{ color: "var(--dim)" }}
          >
            営業日カレンダー
          </p>
          <h1 className="font-display mt-4 text-4xl leading-snug font-bold break-words">
            {shop.name}
          </h1>
          <div className="mt-6 flex justify-center">
            <span
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
              style={{ background: badge.bg, color: badge.color }}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: badge.dot }} />
              {badge.text}
            </span>
          </div>
          {shop.message ? (
            <p className="mx-auto mt-7 max-w-md text-base leading-loose whitespace-pre-wrap">
              {shop.message}
            </p>
          ) : null}
        </header>

        {/* カレンダー */}
        <Card>
          <MonthNav
            yearMonth={yearMonth}
            onChange={(ym) => setYearMonth(ym)}
          />
          <CalendarGrid
            rules={shop}
            overrides={overrides}
            yearMonth={yearMonth}
            today={today}
            selected={selected}
            onSelect={setSelected}
          />
          <div
            className="mt-4 flex items-center gap-5 border-t pt-4 text-xs"
            style={{ borderColor: "var(--border)", color: "var(--dim)" }}
          >
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-3.5 w-3.5 rounded-md"
                style={{ background: "var(--closed-bg)" }}
              />
              休業日
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-3.5 w-3.5 rounded-md"
                style={{ boxShadow: "inset 0 0 0 2px var(--accent)" }}
              />
              今日
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: "var(--accent)" }}
              />
              お知らせあり
            </span>
          </div>
        </Card>

        {/* 選択日の詳細 */}
        <section
          className="mt-4 rounded-[28px] p-5 sm:p-6"
          style={{ background: "var(--surface-alt)" }}
        >
          <h3 className="text-base font-bold">{dateLabel(selected)}</h3>
          <p className="mt-2 leading-relaxed">
            {selectedOpen ? (
              <>
                営業日です
                <span className="tnum ml-2">
                  {selectedHours.open}〜{selectedHours.close}
                </span>
                {selectedHours.custom ? (
                  <span className="ml-2 text-sm" style={{ color: "var(--dim)" }}>
                    （この日は時間が変わります）
                  </span>
                ) : null}
              </>
            ) : (
              <span style={{ color: "var(--closed)" }}>休業日です</span>
            )}
          </p>
          {selectedOv?.note ? (
            <p className="mt-3 leading-relaxed whitespace-pre-wrap">{selectedOv.note}</p>
          ) : null}
        </section>

        {/* お店の案内 */}
        <section className="mt-10 space-y-4 px-1">
          <h3
            className="text-xs font-semibold tracking-[0.3em]"
            style={{ color: "var(--dim)" }}
          >
            お店のご案内
          </h3>
          <dl className="space-y-3 text-base">
            <div className="flex gap-4">
              <dt className="w-20 shrink-0" style={{ color: "var(--dim)" }}>
                営業時間
              </dt>
              <dd className="tnum">
                {shop.openTime}〜{shop.closeTime}
              </dd>
            </div>
            <div className="flex gap-4">
              <dt className="w-20 shrink-0" style={{ color: "var(--dim)" }}>
                定休日
              </dt>
              <dd>{closedRuleText(shop)}</dd>
            </div>
            {shop.address ? (
              <div className="flex gap-4">
                <dt className="w-20 shrink-0" style={{ color: "var(--dim)" }}>
                  住所
                </dt>
                <dd className="break-words">{shop.address}</dd>
              </div>
            ) : null}
            {shop.phone ? (
              <div className="flex gap-4">
                <dt className="w-20 shrink-0" style={{ color: "var(--dim)" }}>
                  電話
                </dt>
                <dd>
                  <a href={`tel:${shop.phone}`} className="tnum underline underline-offset-4">
                    {shop.phone}
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
          {shop.instagramUrl ? (
            <a
              href={shop.instagramUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 flex min-h-14 items-center justify-center rounded-2xl border text-base font-semibold"
              style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
            >
              Instagramを見る
            </a>
          ) : null}
        </section>

        {/* 最終更新 */}
        {updatedText ? (
          <p className="mt-12 text-center text-sm" style={{ color: "var(--dim)" }}>
            最終更新：{updatedText}
          </p>
        ) : null}
        <p className="mt-3 text-center text-xs tracking-widest" style={{ color: "var(--dim)" }}>
          営業日カレンダー
        </p>
      </main>
    </div>
  );
}

// ---------- landing (/) ----------

function LandingPage() {
  return (
    <div style={{ background: "var(--bg)", color: "var(--text)" }}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto min-h-dvh w-full max-w-xl px-5 pb-16">
        <header className="pt-16 pb-10 text-center">
          <p className="text-xs font-semibold tracking-[0.35em]" style={{ color: "var(--dim)" }}>
            個人店のための
          </p>
          <h1 className="font-display mt-4 text-4xl leading-snug font-bold">営業日カレンダー</h1>
          <p className="mx-auto mt-6 max-w-md leading-loose" style={{ color: "var(--dim)" }}>
            お店の営業日を、リンクひとつでお知らせ。
            <br />
            Instagram・公式LINE・ホームページに貼るだけ。
            <br />
            急なお休みも、スマホからすぐに反映できます。
          </p>
        </header>

        <div className="space-y-3">
          <a href="/signup" className="block">
            <PrimaryButton>新規登録をはじめる</PrimaryButton>
          </a>
          <a href="/login" className="block">
            <GhostButton>ログイン</GhostButton>
          </a>
        </div>

        <div className="mt-12 space-y-4">
          {[
            {
              title: "リンクを貼るだけ",
              body: "登録するとあなたのお店専用のURLが発行されます。あとはそのリンクをプロフィールや投稿に貼るだけです。",
            },
            {
              title: "急な変更も即反映",
              body: "「今日はお休み」も、営業日の画像を作り直す必要はありません。スマホでカレンダーをタップすれば、その場で反映されます。",
            },
            {
              title: "最終更新が見える",
              body: "カレンダーには最終更新日が表示されます。お客さんは「ちゃんと更新されている」ことが分かり、安心して見られます。",
            },
          ].map((f) => (
            <Card key={f.title}>
              <h2 className="text-lg font-bold">{f.title}</h2>
              <p className="mt-2 leading-relaxed" style={{ color: "var(--dim)" }}>
                {f.body}
              </p>
            </Card>
          ))}
        </div>

        <p className="mt-12 text-center text-xs tracking-widest" style={{ color: "var(--dim)" }}>
          営業日カレンダー
        </p>
      </main>
    </div>
  );
}

// ---------- auth (login / signup) ----------

function AuthShell(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--bg)", color: "var(--text)" }}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto min-h-dvh w-full max-w-xl px-5 pt-14 pb-16">
        <p className="text-center text-xs font-semibold tracking-[0.35em]" style={{ color: "var(--dim)" }}>
          営業日カレンダー
        </p>
        <h1 className="font-display mt-3 text-center text-3xl font-bold">{props.title}</h1>
        <div className="mt-10">
          <Card>{props.children}</Card>
        </div>
      </main>
    </div>
  );
}

function SignupPage() {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.signup({ slug: slug.trim(), name, password });
      if (!res.ok) {
        setError(res.error ?? "登録に失敗しました");
        return;
      }
      if (res.editToken && res.slug) {
        try {
          sessionStorage.setItem(`editToken:${res.slug}`, res.editToken);
        } catch {
          // 保存できなくても編集画面は使える
        }
      }
      window.location.assign(`/${res.slug}/edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登録に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="新規登録">
      <form onSubmit={submit} className="space-y-5">
        <TextInput label="お店の名前" value={name} onChange={setName} autoComplete="organization" />
        <TextInput
          label="ID（公開URLになります）"
          value={slug}
          onChange={(v) => setSlug(v.toLowerCase())}
          autoComplete="username"
          placeholder="例：cut-kattyan"
          hint={`英小文字・数字・ハイフン・アンダースコア、3〜30字。公開URLは /${slug.trim() || "your-id"} になります`}
        />
        <TextInput
          label="パスワード"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="8文字以上で設定してください"
        />
        <ErrorBox message={error} />
        <PrimaryButton type="submit" disabled={busy}>
          登録してカレンダーを作る
        </PrimaryButton>
        <p className="text-center text-sm" style={{ color: "var(--dim)" }}>
          すでに登録済みの方は{" "}
          <a href="/login" className="underline underline-offset-4">
            ログイン
          </a>
        </p>
      </form>
    </AuthShell>
  );
}

function LoginPage() {
  const [slug, setSlug] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.login({ slug: slug.trim(), password });
      if (!res.ok) {
        setError(res.error ?? "ログインに失敗しました");
        return;
      }
      window.location.assign(`/${res.slug}/edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="ログイン">
      <form onSubmit={submit} className="space-y-5">
        <TextInput
          label="ID"
          value={slug}
          onChange={(v) => setSlug(v.toLowerCase())}
          autoComplete="username"
          placeholder="例：cut-kattyan"
        />
        <TextInput
          label="パスワード"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <ErrorBox message={error} />
        <PrimaryButton type="submit" disabled={busy}>
          ログイン
        </PrimaryButton>
        <p className="text-center text-sm" style={{ color: "var(--dim)" }}>
          編集リンクをお持ちの方は、そのリンクを開くだけで編集できます
        </p>
      </form>
    </AuthShell>
  );
}

// ---------- edit link redemption (/<slug>/<uuid>) ----------

function RedeemPage(props: { slug: string; token: string }) {
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    (async () => {
      try {
        const res = await api.redeemEditLink({ slug: props.slug, token: props.token });
        if (res.ok) {
          try {
            sessionStorage.setItem(`editToken:${props.slug}`, props.token);
          } catch {
            // ignore
          }
          window.location.replace(`/${props.slug}/edit`);
        } else {
          setError(res.error ?? "この編集リンクは無効です");
        }
      } catch {
        setError("この編集リンクは無効です");
      }
    })();
  }, [props.slug, props.token]);

  return (
    <div
      className="flex min-h-dvh items-center justify-center px-6"
      style={{ background: "var(--bg)", color: "var(--text)" }}
    >
      <div className="max-w-md text-center">
        {error ? (
          <>
            <h1 className="font-display text-2xl font-bold">編集リンクが無効です</h1>
            <p className="mt-4 leading-relaxed" style={{ color: "var(--dim)" }}>
              リンクが再発行されて古くなっている可能性があります。IDとパスワードでログインするか、お店の公開カレンダーをご覧ください。
            </p>
            <div className="mt-8 space-y-3">
              <a href="/login" className="block">
                <PrimaryButton>ログインする</PrimaryButton>
              </a>
              <a href={`/${props.slug}`} className="block">
                <GhostButton>公開カレンダーを見る</GhostButton>
              </a>
            </div>
          </>
        ) : (
          <p style={{ color: "var(--dim)" }}>編集画面を開いています…</p>
        )}
      </div>
    </div>
  );
}

// ---------- edit page (/<slug>/edit) ----------

type ThemeKey = "standard" | "warm" | "sakura" | "forest" | "ocean" | "mono";

function EditPage(props: { slug: string }) {
  const queryClient = useQueryClient();
  const today = todayJST();
  const [yearMonth, setYearMonth] = useState(ymOf(today));
  const [selected, setSelected] = useState<string>(today);

  const sessionQ = useQuery({
    queryKey: ["session"],
    queryFn: () => api.getSession({}),
  });
  const canEdit = sessionQ.data?.loggedIn === true && sessionQ.data.slug === props.slug;

  const editQ = useQuery({
    queryKey: ["edit", props.slug, yearMonth],
    queryFn: () => api.getEditState({ slug: props.slug, yearMonth }),
    enabled: canEdit,
  });

  const shop = editQ.data?.shop ?? null;
  const scope = editQ.data?.scope ?? sessionQ.data?.scope ?? null;
  const overrides = useMemo(() => {
    const map = new Map<string, Override>();
    for (const o of editQ.data?.overrides ?? []) map.set(o.date, o);
    return map;
  }, [editQ.data]);

  // --- profile form state (initialized once per shop) ---
  const [formReadyFor, setFormReadyFor] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [openTime, setOpenTime] = useState("09:00");
  const [closeTime, setCloseTime] = useState("19:00");
  const [message, setMessage] = useState("");
  const [instagramUrl, setInstagramUrl] = useState("");
  const [theme, setTheme] = useState<ThemeKey>("standard");
  const [closedWeekdays, setClosedWeekdays] = useState<number[]>([]);
  const [nthClosures, setNthClosures] = useState<{ nth: number; weekday: number }[]>([]);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  useEffect(() => {
    if (shop && formReadyFor !== shop.slug) {
      setName(shop.name);
      setAddress(shop.address);
      setPhone(shop.phone);
      setOpenTime(shop.openTime);
      setCloseTime(shop.closeTime);
      setMessage(shop.message);
      setInstagramUrl(shop.instagramUrl);
      setTheme((THEME_OPTIONS.some((t) => t.key === shop.theme) ? shop.theme : "standard") as ThemeKey);
      setClosedWeekdays(shop.closedWeekdays);
      setNthClosures(shop.nthClosures);
      setFormReadyFor(shop.slug);
    }
  }, [shop, formReadyFor]);

  // --- selected-day panel state ---
  const selectedOv = overrides.get(selected);
  const selectedOpen = shop ? isOpenDay(shop, overrides, selected) : false;
  const [noteDraft, setNoteDraft] = useState("");
  const [useCustomHours, setUseCustomHours] = useState(false);
  const [hoursOpen, setHoursOpen] = useState("09:00");
  const [hoursClose, setHoursClose] = useState("19:00");

  useEffect(() => {
    setNoteDraft(selectedOv?.note ?? "");
    if (selectedOv?.hours) {
      const [o = "09:00", c = "19:00"] = selectedOv.hours.split("-");
      setHoursOpen(o);
      setHoursClose(c);
      setUseCustomHours(true);
    } else {
      setUseCustomHours(false);
      if (shop) {
        setHoursOpen(shop.openTime);
        setHoursClose(shop.closeTime);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, editQ.data]);

  // --- edit link state ---
  const [editToken, setEditToken] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(`editToken:${props.slug}`);
    } catch {
      return null;
    }
  });
  const [confirmReissue, setConfirmReissue] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      setCopied(null);
    }
  }

  // --- password change state ---
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries();
  };

  const dayMutation = useMutation({
    mutationFn: (args: Parameters<typeof api.setDayOverride>[0]) => api.setDayOverride(args),
    onSuccess: invalidate,
  });

  const profileMutation = useMutation({
    mutationFn: (args: Parameters<typeof api.updateProfile>[0]) => api.updateProfile(args),
    onSuccess: (res) => {
      if (res.ok) {
        setProfileErr(null);
        setProfileMsg("保存しました");
        invalidate();
      } else {
        setProfileMsg(null);
        setProfileErr(res.error ?? "保存に失敗しました");
      }
    },
    onError: (err) => setProfileErr(err instanceof Error ? err.message : "保存に失敗しました"),
  });

  const pwMutation = useMutation({
    mutationFn: (args: Parameters<typeof api.changePassword>[0]) => api.changePassword(args),
    onSuccess: (res) => {
      if (res.ok) {
        setPwErr(null);
        setPwMsg("パスワードを変更しました");
        setCurrentPw("");
        setNewPw("");
      } else {
        setPwMsg(null);
        setPwErr(res.error ?? "変更に失敗しました");
      }
    },
    onError: (err) => setPwErr(err instanceof Error ? err.message : "変更に失敗しました"),
  });

  const reissueMutation = useMutation({
    mutationFn: () => api.reissueEditToken({ slug: props.slug }),
    onSuccess: (res) => {
      if (res.ok && res.editToken) {
        setEditToken(res.editToken);
        try {
          sessionStorage.setItem(`editToken:${props.slug}`, res.editToken);
        } catch {
          // ignore
        }
      }
      setConfirmReissue(false);
    },
  });

  // --- gates ---
  if (sessionQ.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center" style={{ background: "var(--bg)" }}>
        <p style={{ color: "var(--dim)" }}>読み込み中…</p>
      </div>
    );
  }
  if (!canEdit) {
    return (
      <div style={{ background: "var(--bg)", color: "var(--text)" }}>
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto flex min-h-dvh w-full max-w-xl items-center px-5">
          <Card className="w-full">
            <h1 className="font-display text-2xl font-bold">編集にはログインが必要です</h1>
            <p className="mt-4 leading-relaxed" style={{ color: "var(--dim)" }}>
              このカレンダーを編集するには、IDとパスワードでログインするか、お店専用の編集リンクを開いてください。
            </p>
            <div className="mt-6 space-y-3">
              <a href="/login" className="block">
                <PrimaryButton>ログインする</PrimaryButton>
              </a>
              <a href={`/${props.slug}`} className="block">
                <GhostButton>公開カレンダーを見る</GhostButton>
              </a>
            </div>
          </Card>
        </main>
      </div>
    );
  }
  if (editQ.isLoading || !shop) {
    return (
      <div className="flex min-h-dvh items-center justify-center" style={{ background: "var(--bg)" }}>
        <p style={{ color: "var(--dim)" }}>読み込み中…</p>
      </div>
    );
  }

  const origin = window.location.origin;
  const publicUrl = `${origin}/${props.slug}`;
  const editUrl = editToken ? `${origin}/${props.slug}/${editToken}` : null;

  function handleDayTap(date: string) {
    setSelected(date);
    if (!shop) return;
    const open = isOpenDay(shop, overrides, date);
    const ov = overrides.get(date);
    dayMutation.mutate({
      slug: props.slug,
      date,
      kind: open ? "closed" : "open",
      note: ov?.note ?? "",
      hours: ov?.hours ?? "",
    });
  }

  function saveDayDetails() {
    dayMutation.mutate({
      slug: props.slug,
      date: selected,
      kind: selectedOpen ? "open" : "closed",
      note: noteDraft,
      hours: useCustomHours ? `${hoursOpen}-${hoursClose}` : "",
    });
  }

  function clearDayOverride() {
    dayMutation.mutate({ slug: props.slug, date: selected, kind: "clear", note: "", hours: "" });
  }

  function saveProfile() {
    setProfileMsg(null);
    setProfileErr(null);
    profileMutation.mutate({
      slug: props.slug,
      name,
      address,
      phone,
      openTime,
      closeTime,
      closedWeekdays,
      nthClosures,
      message,
      theme,
      instagramUrl,
    });
  }

  async function logout() {
    try {
      await api.logout({});
    } catch {
      // ignore
    }
    window.location.assign(`/${props.slug}`);
  }

  return (
    <div data-theme={theme} style={{ background: "var(--bg)", color: "var(--text)" }}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto min-h-dvh w-full max-w-xl px-5 pt-10 pb-16">
        <header className="mb-8">
          <p className="text-xs font-semibold tracking-[0.35em]" style={{ color: "var(--dim)" }}>
            カレンダーの編集
          </p>
          <h1 className="font-display mt-3 text-3xl font-bold break-words">{shop.name}</h1>
          <a
            href={`/${props.slug}`}
            className="mt-3 inline-block text-sm underline underline-offset-4"
            style={{ color: "var(--dim)" }}
          >
            公開カレンダーを見る（/{props.slug}）
          </a>
        </header>

        {/* カレンダー編集 */}
        <Card>
          <MonthNav yearMonth={yearMonth} onChange={setYearMonth} />
          <CalendarGrid
            rules={shop}
            overrides={overrides}
            yearMonth={yearMonth}
            today={today}
            selected={selected}
            onSelect={handleDayTap}
          />
          <p className="mt-4 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
            日付をタップすると営業日／休業日が切り替わります。
          </p>

          <div
            className="mt-5 border-t pt-5"
            style={{ borderColor: "var(--border)" }}
          >
            <h3 className="text-base font-bold">{dateLabel(selected)}</h3>
            <p className="mt-1 text-sm" style={{ color: selectedOpen ? "var(--open)" : "var(--closed)" }}>
              {selectedOpen ? "営業日" : "休業日"}
              {selectedOv ? "（個別に設定中）" : "（定休日ルール通り）"}
            </p>
            <div className="mt-4 space-y-4">
              <TextInput
                label="この日のメモ（公開カレンダーに表示）"
                value={noteDraft}
                onChange={setNoteDraft}
                placeholder="例：午後から営業します"
              />
              <div>
                <span
                  className="mb-2 block text-sm font-semibold tracking-wide"
                  style={{ color: "var(--dim)" }}
                >
                  この日の営業時間
                </span>
                <label className="flex min-h-12 items-center gap-3 text-base">
                  <input
                    type="checkbox"
                    checked={useCustomHours}
                    onChange={(e) => setUseCustomHours(e.target.checked)}
                    className="h-6 w-6"
                  />
                  通常と違う時間にする
                </label>
                {useCustomHours ? (
                  <div className="mt-2 flex items-center gap-3">
                    <input
                      type="time"
                      value={hoursOpen}
                      onChange={(e) => setHoursOpen(e.target.value)}
                      className="tnum min-h-14 flex-1 rounded-2xl border px-4 text-base"
                      style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }}
                    />
                    <span>〜</span>
                    <input
                      type="time"
                      value={hoursClose}
                      onChange={(e) => setHoursClose(e.target.value)}
                      className="tnum min-h-14 flex-1 rounded-2xl border px-4 text-base"
                      style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }}
                    />
                  </div>
                ) : null}
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <PrimaryButton onClick={saveDayDetails} disabled={dayMutation.isPending}>
                    この日の内容を保存
                  </PrimaryButton>
                </div>
                {selectedOv ? (
                  <div className="flex-1">
                    <GhostButton onClick={clearDayOverride} disabled={dayMutation.isPending}>
                      個別設定を解除
                    </GhostButton>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </Card>

        {/* お店の設定 */}
        <Card className="mt-6">
          <h2 className="text-lg font-bold">お店の設定</h2>
          <div className="mt-5 space-y-5">
            <TextInput label="お店の名前" value={name} onChange={setName} />
            <label className="block">
              <span className="mb-2 block text-sm font-semibold tracking-wide" style={{ color: "var(--dim)" }}>
                店主の一言（公開カレンダーに表示）
              </span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                className="w-full rounded-2xl border px-4 py-3 text-base leading-relaxed outline-none"
                style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }}
                placeholder="例：いつもありがとうございます。ご来店お待ちしております。"
              />
            </label>
            <div className="flex gap-3">
              <div className="flex-1">
                <TextInput label="開店時間" type="time" value={openTime} onChange={setOpenTime} />
              </div>
              <div className="flex-1">
                <TextInput label="閉店時間" type="time" value={closeTime} onChange={setCloseTime} />
              </div>
            </div>
            <div>
              <span className="mb-2 block text-sm font-semibold tracking-wide" style={{ color: "var(--dim)" }}>
                定休日（毎週）
              </span>
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_LABELS.map((w, i) => {
                  const active = closedWeekdays.includes(i);
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() =>
                        setClosedWeekdays(active ? closedWeekdays.filter((d) => d !== i) : [...closedWeekdays, i])
                      }
                      className="min-h-12 min-w-12 rounded-full px-4 text-base font-semibold"
                      style={{
                        background: active ? "var(--closed-bg)" : "var(--surface-alt)",
                        color: active ? "var(--closed)" : "var(--text)",
                      }}
                    >
                      {w}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <span className="mb-2 block text-sm font-semibold tracking-wide" style={{ color: "var(--dim)" }}>
                定休日（第○曜日）
              </span>
              <div className="space-y-2">
                {nthClosures.map((c, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={c.nth}
                      onChange={(e) =>
                        setNthClosures(nthClosures.map((x, i) => (i === idx ? { ...x, nth: Number(e.target.value) } : x)))
                      }
                      className="tnum min-h-12 rounded-xl border px-3 text-base"
                      style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }}
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          第{n}
                        </option>
                      ))}
                    </select>
                    <select
                      value={c.weekday}
                      onChange={(e) =>
                        setNthClosures(nthClosures.map((x, i) => (i === idx ? { ...x, weekday: Number(e.target.value) } : x)))
                      }
                      className="min-h-12 rounded-xl border px-3 text-base"
                      style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }}
                    >
                      {WEEKDAY_LABELS.map((w, i) => (
                        <option key={w} value={i}>
                          {w}曜日
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setNthClosures(nthClosures.filter((_, i) => i !== idx))}
                      className="min-h-12 rounded-xl px-4 text-sm font-semibold"
                      style={{ background: "var(--closed-bg)", color: "var(--closed)" }}
                    >
                      削除
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setNthClosures([...nthClosures, { nth: 2, weekday: 2 }])}
                  className="min-h-12 rounded-xl px-4 text-sm font-semibold"
                  style={{ background: "var(--surface-alt)", color: "var(--text)" }}
                >
                  ＋ 第○曜日の定休日を追加
                </button>
              </div>
            </div>
            <TextInput label="住所" value={address} onChange={setAddress} />
            <TextInput label="電話番号（お店の連絡先）" value={phone} onChange={setPhone} type="tel" />
            <TextInput
              label="InstagramのURL"
              value={instagramUrl}
              onChange={setInstagramUrl}
              placeholder="https://www.instagram.com/…"
            />
          </div>

          {/* テーマ */}
          <div className="mt-8">
            <span className="mb-3 block text-sm font-semibold tracking-wide" style={{ color: "var(--dim)" }}>
              カレンダーのテーマ
            </span>
            <div className="grid grid-cols-3 gap-2">
              {THEME_OPTIONS.map((t) => {
                const active = theme === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTheme(t.key as ThemeKey)}
                    className="rounded-3xl border p-3 text-left"
                    style={{
                      background: t.bg,
                      borderColor: active ? t.accent : "var(--border)",
                      boxShadow: active ? `inset 0 0 0 2px ${t.accent}` : undefined,
                    }}
                  >
                    <span className="block h-6 w-6 rounded-full" style={{ background: t.accent }} />
                    <span className="mt-2 block text-sm font-semibold" style={{ color: "#33302a" }}>
                      {t.label}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
              選ぶとこの画面の配色も切り替わります。保存すると公開カレンダーに反映されます。
            </p>
          </div>

          <div className="mt-6 space-y-3">
            <ErrorBox message={profileErr} />
            {profileMsg ? (
              <p className="rounded-2xl px-4 py-3 text-sm" style={{ background: "var(--accent-soft)", color: "var(--text)" }}>
                {profileMsg}
              </p>
            ) : null}
            <PrimaryButton onClick={saveProfile} disabled={profileMutation.isPending}>
              設定を保存する
            </PrimaryButton>
          </div>
        </Card>

        {/* リンク */}
        <Card className="mt-6">
          <h2 className="text-lg font-bold">リンク</h2>
          <div className="mt-5 space-y-6">
            <div>
              <span className="mb-2 block text-sm font-semibold tracking-wide" style={{ color: "var(--dim)" }}>
                公開URL（お客さんに伝えるリンク）
              </span>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={publicUrl}
                  className="min-h-14 min-w-0 flex-1 rounded-2xl border px-4 text-sm"
                  style={{ background: "var(--surface-alt)", borderColor: "var(--border)", color: "var(--text)" }}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  onClick={() => void copyText("public", publicUrl)}
                  className="min-h-14 shrink-0 rounded-2xl px-5 font-semibold"
                  style={{ background: "var(--accent)", color: "var(--accent-text)" }}
                >
                  {copied === "public" ? "コピー済み" : "コピー"}
                </button>
              </div>
              <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
                Instagramのプロフィールや公式LINE、ホームページにこのリンクを貼ってください。
              </p>
            </div>
            <div>
              <span className="mb-2 block text-sm font-semibold tracking-wide" style={{ color: "var(--dim)" }}>
                編集リンク（秘密）
              </span>
              {editUrl ? (
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={editUrl}
                    className="min-h-14 min-w-0 flex-1 rounded-2xl border px-4 text-sm"
                    style={{ background: "var(--surface-alt)", borderColor: "var(--border)", color: "var(--text)" }}
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    onClick={() => void copyText("edit", editUrl)}
                    className="min-h-14 shrink-0 rounded-2xl px-5 font-semibold"
                    style={{ background: "var(--accent)", color: "var(--accent-text)" }}
                  >
                    {copied === "edit" ? "コピー済み" : "コピー"}
                  </button>
                </div>
              ) : (
                <p className="text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
                  編集リンクは、発行したときにだけ表示されます（安全のため、サーバーには文字列そのものを保存していません）。下のボタンで再発行すると、新しいリンクが表示されます。
                </p>
              )}
              <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--closed)" }}>
                このリンクを知っている人は誰でもカレンダーを編集できます。人に教えたり、公開したりしないでください。
              </p>
              {confirmReissue ? (
                <div className="mt-3 space-y-3">
                  <p className="text-sm leading-relaxed">
                    再発行すると、今までの編集リンクは使えなくなります。よろしいですか？
                  </p>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <PrimaryButton onClick={() => reissueMutation.mutate()} disabled={reissueMutation.isPending}>
                        再発行する
                      </PrimaryButton>
                    </div>
                    <div className="flex-1">
                      <GhostButton onClick={() => setConfirmReissue(false)}>やめる</GhostButton>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <GhostButton onClick={() => setConfirmReissue(true)}>編集リンクを再発行する</GhostButton>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* パスワード */}
        {scope === "owner" ? (
          <Card className="mt-6">
            <h2 className="text-lg font-bold">パスワードの変更</h2>
            <div className="mt-5 space-y-5">
              <TextInput
                label="今のパスワード"
                type="password"
                value={currentPw}
                onChange={setCurrentPw}
                autoComplete="current-password"
              />
              <TextInput
                label="新しいパスワード"
                type="password"
                value={newPw}
                onChange={setNewPw}
                autoComplete="new-password"
                hint="8文字以上で設定してください"
              />
              <ErrorBox message={pwErr} />
              {pwMsg ? (
                <p className="rounded-2xl px-4 py-3 text-sm" style={{ background: "var(--accent-soft)", color: "var(--text)" }}>
                  {pwMsg}
                </p>
              ) : null}
              <PrimaryButton
                onClick={() => {
                  setPwMsg(null);
                  setPwErr(null);
                  pwMutation.mutate({ slug: props.slug, currentPassword: currentPw, newPassword: newPw });
                }}
                disabled={pwMutation.isPending}
              >
                パスワードを変更する
              </PrimaryButton>
            </div>
          </Card>
        ) : shop.hasPassword ? (
          <p className="mt-6 px-2 text-sm leading-relaxed" style={{ color: "var(--dim)" }}>
            パスワードの変更は、IDとパスワードでログインしているときだけ行えます。
          </p>
        ) : null}

        <div className="mt-8">
          <GhostButton onClick={() => void logout()}>ログアウト</GhostButton>
        </div>
      </main>
    </div>
  );
}

// ---------- admin (/admin) ----------

function AdminPage() {
  const queryClient = useQueryClient();
  const statusQ = useQuery({ queryKey: ["adminStatus"], queryFn: () => api.getAdminStatus({}) });
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [newAdminPw, setNewAdminPw] = useState("");
  const [adminPwMsg, setAdminPwMsg] = useState<string | null>(null);

  const accountsQ = useQuery({
    queryKey: ["adminAccounts"],
    queryFn: () => api.adminListAccounts({ adminPassword: password }),
    enabled: unlocked,
  });

  async function setup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.setupAdminPassword({ newPassword: password });
      if (!res.ok) {
        setError(res.error ?? "設定に失敗しました");
        return;
      }
      setUnlocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "設定に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.verifyAdminPassword({ password });
      if (!res.ok) {
        setError("パスワードが違います");
        return;
      }
      setUnlocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "認証に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount(shopId: number) {
    setError(null);
    try {
      const res = await api.adminDeleteAccount({ adminPassword: password, shopId });
      if (!res.ok) {
        setError(res.error ?? "削除に失敗しました");
        return;
      }
      setConfirmDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: ["adminAccounts"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    }
  }

  async function changeAdminPw() {
    setAdminPwMsg(null);
    setError(null);
    try {
      const res = await api.changeAdminPassword({ currentPassword: password, newPassword: newAdminPw });
      if (!res.ok) {
        setError(res.error ?? "変更に失敗しました");
        return;
      }
      setPassword(newAdminPw);
      setNewAdminPw("");
      setAdminPwMsg("管理者パスワードを変更しました");
    } catch (err) {
      setError(err instanceof Error ? err.message : "変更に失敗しました");
    }
  }

  return (
    <div style={{ background: "var(--bg)", color: "var(--text)" }}>
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto min-h-dvh w-full max-w-xl px-5 pt-14 pb-16">
        <h1 className="font-display text-3xl font-bold">全体管理</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--dim)" }}>
          運営用ページです。アカウントの一覧と削除だけを行います（登録は各お店のセルフ登録）。
        </p>

        {statusQ.isLoading ? (
          <p className="mt-10" style={{ color: "var(--dim)" }}>
            読み込み中…
          </p>
        ) : !unlocked ? (
          <Card className="mt-8">
            <form onSubmit={statusQ.data?.needsSetup ? setup : login} className="space-y-5">
              <TextInput
                label={statusQ.data?.needsSetup ? "管理者パスワードを設定" : "管理者パスワード"}
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete={statusQ.data?.needsSetup ? "new-password" : "current-password"}
                hint={
                  statusQ.data?.needsSetup
                    ? "まだ設定されていません。最初に開いた管理者本人がここで設定します"
                    : undefined
                }
              />
              <ErrorBox message={error} />
              <PrimaryButton type="submit" disabled={busy}>
                {statusQ.data?.needsSetup ? "設定して開く" : "開く"}
              </PrimaryButton>
            </form>
          </Card>
        ) : (
          <div className="mt-8 space-y-6">
            <ErrorBox message={error} />
            <Card>
              <h2 className="text-lg font-bold">アカウント一覧</h2>
              {accountsQ.isLoading ? (
                <p className="mt-4" style={{ color: "var(--dim)" }}>
                  読み込み中…
                </p>
              ) : (accountsQ.data?.accounts.length ?? 0) === 0 ? (
                <p className="mt-4" style={{ color: "var(--dim)" }}>
                  アカウントはまだありません
                </p>
              ) : (
                <ul className="mt-4 space-y-4">
                  {accountsQ.data?.accounts.map((a) => (
                    <li
                      key={a.id}
                      className="rounded-2xl border p-4"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-bold">{a.name}</p>
                          <p className="tnum mt-1 text-sm" style={{ color: "var(--dim)" }}>
                            /{a.slug} ／ パスワード{a.hasPassword ? "設定済み" : "未設定"} ／ 編集リンク
                            {a.editTokenSet ? "発行済み" : "未発行"}
                          </p>
                          <p className="mt-1 text-sm" style={{ color: "var(--dim)" }}>
                            最終更新：{a.updatedAt ? relativeUpdated(a.updatedAt, todayJST()) ?? "—" : "—"}
                          </p>
                        </div>
                        {confirmDeleteId === a.id ? (
                          <div className="flex shrink-0 flex-col gap-2">
                            <button
                              type="button"
                              onClick={() => void deleteAccount(a.id)}
                              className="min-h-11 rounded-xl px-4 text-sm font-semibold"
                              style={{ background: "var(--closed)", color: "#fff" }}
                            >
                              本当に削除
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="min-h-11 rounded-xl px-4 text-sm font-semibold"
                              style={{ background: "var(--surface-alt)", color: "var(--text)" }}
                            >
                              やめる
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(a.id)}
                            className="min-h-11 shrink-0 rounded-xl px-4 text-sm font-semibold"
                            style={{ background: "var(--closed-bg)", color: "var(--closed)" }}
                          >
                            削除
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <h2 className="text-lg font-bold">管理者パスワードの変更</h2>
              <div className="mt-4 space-y-4">
                <TextInput
                  label="新しいパスワード"
                  type="password"
                  value={newAdminPw}
                  onChange={setNewAdminPw}
                  autoComplete="new-password"
                />
                {adminPwMsg ? (
                  <p className="rounded-2xl px-4 py-3 text-sm" style={{ background: "var(--accent-soft)" }}>
                    {adminPwMsg}
                  </p>
                ) : null}
                <PrimaryButton onClick={() => void changeAdminPw()}>変更する</PrimaryButton>
              </div>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}

// ---------- router ----------

export function App() {
  const segments = window.location.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return <LandingPage />;
  const [first, second] = segments;
  if (first === "login" && segments.length === 1) return <LoginPage />;
  if (first === "signup" && segments.length === 1) return <SignupPage />;
  if (first === "admin" && segments.length === 1) return <AdminPage />;
  if (segments.length === 1) return <PublicCalendarPage slug={first as string} />;
  if (segments.length === 2 && second === "edit") {
    return <EditPage slug={first as string} />;
  }
  if (segments.length === 2) {
    return <RedeemPage slug={first as string} token={second as string} />;
  }
  return <PublicCalendarPage slug={first as string} />;
}
