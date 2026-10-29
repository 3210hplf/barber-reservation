# 床屋の予約管理（barber-reservation）

2店舗分の理容室（床屋）の予約を管理する Web アプリです。お客さんはカレンダーから空き枠を選んで予約でき、店主側は予約一覧の確認、営業日の編集、店舗・メニューの設定ができます。

- フロントエンド: React + TypeScript（Tailwind CSS）
- バックエンド: Bun + TypeScript（自前の RPC アクション層）
- データベース: SQLite（Drizzle ORM、ファイルは `data/barber.db`）

このリポジトリは Mac のローカル環境でそのまま動作確認できる構成になっています。

## セットアップ（Mac）

### 1. 前提ツール

- [Bun](https://bun.sh) — Homebrew で入れる場合:

```bash
brew install oven-sh/bun/bun
bun --version   # 動作確認
```

- （任意）DB の中身を直接確認したい場合は `sqlite3` コマンド（macOS には標準で入っています）

### 2. リポジトリを取得して依存をインストール

```bash
git clone https://github.com/3210hplf/barber-reservation.git
cd barber-reservation
bun install
```

### 3. DB マイグレーションと初期データ投入

```bash
bun run db:migrate
```

- `drizzle/` フォルダのマイグレーション SQL を適用し、`data/barber.db` を作成します。
- 店舗がまだ無い場合だけ、初期データ（店舗2件＋各店のデフォルトメニュー6件）を投入します。何度実行しても二重投入はされません。

### 4. 開発サーバーを起動

```bash
bun run dev
```

`db:migrate` → クライアントのビルド → サーバー起動、までをまとめて行います。

### 5. ブラウザで確認

http://localhost:3000 を開いてください。

- お客さん側: 店舗を選ぶ → カレンダーで日付 → 時間枠 → メニュー → 名前・電話番号で予約
- 店主側: 画面内の店主向けメニューから予約一覧・営業日・設定を操作

## 主なスクリプト

| コマンド | 内容 |
| --- | --- |
| `bun run dev` | マイグレーション → クライアントビルド → サーバー起動（http://localhost:3000） |
| `bun run start` | サーバーだけを起動（事前に `bun run build` と `bun run db:migrate` が必要） |
| `bun run build` | クライアントを `client/dist/` にビルド（`build:client` の別名） |
| `bun run build:client` | React バンドル + Tailwind CSS + index.html を `client/dist/` に生成 |
| `bun run db:migrate` | マイグレーション適用＋初期データ投入（空の場合のみ） |
| `bun run typecheck` | client / server 両方の TypeScript 型チェック |

補足:

- サーバーは起動時にもマイグレーションを自動適用します（初期データの投入はしません。ただし予約データ取得のアクション `getState` は、店舗が空なら初期データを投入します）。
- ポートは環境変数 `PORT` で変更できます（既定: 3000）。
- DB ファイルの場所は環境変数 `DATABASE_PATH` で変更できます（既定: `data/barber.db`）。

## ディレクトリ構成

```
.
├── client/
│   ├── index.html        # HTML シェル（ビルド時に dist へコピー）
│   ├── build.mjs         # クライアントのビルドスクリプト（Bun.build + Tailwind CLI）
│   └── src/
│       ├── App.tsx       # 画面全体
│       ├── main.tsx      # エントリポイント（React Query のセットアップ）
│       ├── api.ts        # サーバーへの型付き RPC クライアント（fetch）
│       ├── SafeArea.tsx  # スマホのセーフエリア用スクリム
│       └── theme.css     # Tailwind + テーマ変数
├── server/
│   └── src/
│       ├── index.ts      # Bun.serve（静的配信 + POST /actions）
│       ├── actions.ts    # 業務アクション（getState / createBooking など7つ）
│       ├── framework.ts  # アクション定義・検証の小さなフレームワーク（zod）
│       ├── db.ts         # SQLite 接続とマイグレーション実行
│       ├── migrate.ts    # `bun run db:migrate` の入口（+ 初期データ投入）
│       └── schema.ts     # Drizzle スキーマ（shops / menus / bookings / day_overrides）
├── drizzle/              # マイグレーション SQL
└── data/                 # SQLite ファイルの置き場所（.gitignore 対象）
```

## DB のリセット方法

予約などのデータを全部消して初期状態に戻すには、サーバーを止めてから DB ファイルを削除し、マイグレーションを再実行します。

```bash
rm -f data/barber.db data/barber.db-shm data/barber.db-wal
bun run db:migrate
```

## 技術構成

- **フロントエンド**: React 19 + TypeScript、状態取得に TanStack Query、スタイルは Tailwind CSS 4
- **バックエンド**: Bun（`Bun.serve`）上で TypeScript をそのまま実行。`POST /actions` に `{action, args}` を送る RPC 形式で、zod スキーマで入力検証します
- **DB**: SQLite（`bun:sqlite` + Drizzle ORM）。マイグレーションは `drizzle/` の SQL を Drizzle の migrator で適用
- **型の共有**: クライアントは `server/src/actions.ts` の型をそのまま import するため、API の型がずれません（型のみの import で、サーバーの実行コードはブラウザ側に含まれません）
