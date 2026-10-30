# 床屋の予約管理（barber-reservation）

2店舗分の理容室（床屋）の予約を管理する Web アプリです。お客さんはカレンダーから空き枠を選んで予約でき、店主側は予約一覧の確認、営業日の編集、店舗・メニューの設定ができます。

- フロントエンド: React + TypeScript（Tailwind CSS）
- バックエンド: Bun + TypeScript（自前の RPC アクション層）
- データベース: SQLite（Drizzle ORM、ファイルは `data/barber.db`）

店主側の画面は店舗ごとの暗証番号（4桁）で保護されています。既知の初期番号は無く、初回に店主本人がその場で設定します。ホーム画面に追加してアプリのように使える PWA 対応（マニフェスト＋アイコン＋追加手順の案内）も入っています。

このリポジトリは Mac のローカル環境でそのまま動作確認できる構成になっています。本番の公開先は **Cloudflare Workers + D1** を想定しています（手順は後述）。

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

- お客さん側: 店舗を選ぶ → カレンダーで日付 → 時間枠 → メニュー → 名前・電話番号で予約。自分の予約の確認・取消は、予約時の電話番号で照会します（氏名・電話番号は公開データには含まれません）
- 店主側: 店主画面に入るとき店舗ごとの暗証番号が必要です。未設定の店舗は、最初に開いたときに自分で決めた4桁を設定します（設定後はこの初回設定は使えません）。予約一覧（氏名・電話番号つき）や設定の変更は、裏側でも暗証番号で照合されます

## 主なスクリプト

| コマンド | 内容 |
| --- | --- |
| `bun run dev` | マイグレーション → クライアントビルド → サーバー起動（http://localhost:3000） |
| `bun run start` | サーバーだけを起動（事前に `bun run build` と `bun run db:migrate` が必要） |
| `bun run build` | クライアントを `client/dist/` にビルド（`build:client` の別名） |
| `bun run build:client` | React バンドル + Tailwind CSS + index.html を `client/dist/` に生成 |
| `bun run db:migrate` | マイグレーション適用＋初期データ投入（空の場合のみ） |
| `bun run typecheck` | client / server / worker の TypeScript 型チェック |
| `bun run dev:cf` | クライアントビルド → `wrangler dev`（Workers + ローカルD1 で起動） |
| `bun run db:migrate:cf:local` | ローカル D1 に `migrations/` を適用 |
| `bun run db:create:cf` | 本番用 D1 データベース `barber-db` を作成（初回のみ） |
| `bun run db:migrate:cf` | 本番 D1 に `migrations/` を適用 |
| `bun run deploy:cf` | クライアントビルド → `wrangler deploy`（本番公開） |

補足:

- サーバーは起動時にもマイグレーションを自動適用します（初期データの投入はしません。ただし予約データ取得のアクション `getState` は、店舗が空なら初期データを投入します）。
- ポートは環境変数 `PORT` で変更できます（既定: 3000）。
- DB ファイルの場所は環境変数 `DATABASE_PATH` で変更できます（既定: `data/barber.db`）。

## ディレクトリ構成

```
.
├── client/
│   ├── index.html        # HTML シェル（PWA メタ情報つき。ビルド時に dist へコピー）
│   ├── build.mjs         # クライアントのビルドスクリプト（Bun.build + Tailwind CLI + public/ コピー）
│   ├── public/
│   │   ├── manifest.webmanifest  # PWA マニフェスト
│   │   └── icon.svg              # PWA アイコン（バーバーポール＋ハサミ）
│   └── src/
│       ├── App.tsx       # 画面全体（暗証番号ゲート・ホーム画面追加の案内を含む）
│       ├── main.tsx      # エントリポイント（React Query のセットアップ）
│       ├── api.ts        # サーバーへの型付き RPC クライアント（fetch）
│       ├── SafeArea.tsx  # スマホのセーフエリア用スクリム
│       └── theme.css     # Tailwind + テーマ変数
├── server/
│   ├── worker.ts         # Cloudflare Workers の入口（D1 + 静的アセット配信）
│   ├── tsconfig.worker.json
│   └── src/
│       ├── index.ts      # Bun.serve（静的配信 + POST /actions）
│       ├── actions.ts    # 業務アクション（予約・暗証番号・店主操作など）
│       ├── framework.ts  # アクション定義・検証の小さなフレームワーク（zod）
│       ├── db.ts         # SQLite 接続とマイグレーション実行（Bun 用）
│       ├── migrate.ts    # `bun run db:migrate` の入口（+ 初期データ投入）
│       └── schema.ts     # Drizzle スキーマ（shops / menus / bookings / day_overrides）
├── drizzle/              # マイグレーション SQL（Bun ローカル用）
├── migrations/           # マイグレーション SQL（Cloudflare D1 用）
├── wrangler.toml         # Cloudflare Workers の設定
└── data/                 # SQLite ファイルの置き場所（.gitignore 対象）
```

## DB のリセット方法

予約などのデータを全部消して初期状態に戻すには、サーバーを止めてから DB ファイルを削除し、マイグレーションを再実行します。

```bash
rm -f data/barber.db data/barber.db-shm data/barber.db-wal
bun run db:migrate
```

## Cloudflare Workers へのデプロイ（本番公開）

本番は Cloudflare Workers + D1（SQLite 互換のマネージド DB）で公開します。この規模（2店舗の予約）なら、Workers と D1 の無料枠の範囲で運用できる想定です。画面（静的アセット）と `POST /actions` の両方を1つの Worker が配信し、DB は D1 バインディング（`env.DB`）に差し替わるだけで、アクションのロジックは Bun 版と共通です。

前提: `bun install` 済みであること。

### 1. Cloudflare アカウントを作成し、ログインする

Cloudflare にサインアップ（無料プランで可）してから:

```bash
bun x wrangler login
```

### 2. D1 データベースを作成し、database_id を設定する

```bash
bun run db:create:cf   # = wrangler d1 create barber-db
```

表示された `database_id` を `wrangler.toml` の `database_id`（プレースホルダ）に記入してください。

### 3. 本番 DB にマイグレーションを適用する

```bash
bun run db:migrate:cf   # = wrangler d1 migrations apply barber-db --remote
```

初期データ（店舗2件＋メニュー）は、アプリが初回アクセス時に自動投入します（Bun 版と同じ seedIfEmpty の仕組み）。投入用の SQL は不要です。

### 4. デプロイする

```bash
bun run deploy:cf   # クライアントのビルド → wrangler deploy
```

発行された URL（`https://barber-reservation.<サブドメイン>.workers.dev`）を開いて、予約画面と店主画面（暗証番号の初回設定）を確認してください。お店の方に渡すときは、最初の店主画面でご本人に暗証番号を設定してもらってください。

### ローカルで Workers 版を確認する

```bash
bun run db:migrate:cf:local   # ローカル D1 に migrations/ を適用
bun run dev:cf                # wrangler dev（http://localhost:8787）
```

### 本番まわりの注意

- 暗証番号は平文では保存しません。ソルト付きハッシュ（PBKDF2-HMAC-SHA-256、Web Crypto）で保存し、照合はサーバー側（Worker 側）で行います。公開側の応答に暗証番号や顧客の電話番号・氏名リストは含まれません。
- アイコンは SVG（`client/public/icon.svg`）のみです。GitHub へバイナリを push できない運用上の制約から PNG アイコンを用意していないため、iPhone のホーム画面アイコン（apple-touch-icon、PNG 前提）はブラウザ側の自動生成に委ねられます。必要になったら PNG を別途リポジトリに置く運用に切り替えてください。
- `wrangler.toml` の `database_id` はプレースホルダのままコミットされています。実 ID への差し替えはデプロイする人の環境で行ってください（トークン等の秘密情報はリポジトリに入れないでください）。

## 技術構成

- **フロントエンド**: React 19 + TypeScript、状態取得に TanStack Query、スタイルは Tailwind CSS 4
- **バックエンド**: Bun（`Bun.serve`）上で TypeScript をそのまま実行。`POST /actions` に `{action, args}` を送る RPC 形式で、zod スキーマで入力検証します
- **DB**: SQLite（`bun:sqlite` + Drizzle ORM）。マイグレーションは `drizzle/` の SQL を Drizzle の migrator で適用
- **本番**: Cloudflare Workers（`server/worker.ts`）+ D1（`drizzle-orm/d1`）。マイグレーションは `migrations/` を wrangler で適用。静的アセットは Workers Static Assets から配信（SPA フォールバック設定つき）
- **型の共有**: クライアントは `server/src/actions.ts` の型をそのまま import するため、API の型がずれません（型のみの import で、サーバーの実行コードはブラウザ側に含まれません）
