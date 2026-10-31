# 営業日カレンダー（barber-reservation）

個人店向けの「営業日カレンダー」特化サービスです。お店が ID とパスワードで登録すると、その ID がそのまま公開 URL になり、誰でもログインなしで営業日カレンダーを見られます。Instagram のプロフィールや公式 LINE、ホームページにリンクを貼るだけで、営業日の画像を作り直すことなく、急な休業もスマホからすぐに反映できます。

**予約機能はありません。お客さんの氏名・電話番号などの個人情報は一切扱いません。**（DB にも項目自体が存在しません）

- フロントエンド: React + TypeScript（Tailwind CSS）
- バックエンド: Cloudflare Workers + TypeScript（ローカル開発は Bun）
- データベース: D1（本番）/ SQLite（ローカル、Drizzle ORM）

### URL構成と利用モデル

- `/` … サービス紹介ランディング（ログイン／新規登録ボタン）
- `/signup`、`/login` … 登録とログイン（ID + パスワード）
- `/<ID>` … 公開カレンダー。誰でも閲覧できます。店名、本日の状態（営業中／営業日／休業日）、店主の一言、月カレンダー（休業日、その日のメモ・時間変更）、営業時間・定休日、最終更新日（相対表現つき）が表示されます
- `/<ID>/edit` … 編集画面。ログイン、または秘密の編集リンクで得たセッションが必要です。日タップで営業／休業の切替、その日のメモ・営業時間の上書き、店名・一言・営業時間・定休日ルール・住所・電話（お店の連絡先）・Instagram の設定、テーマ選択、リンク管理、パスワード変更ができます
- `/<ID>/<UUID>` … 秘密の編集リンク。開くと照合され、そのカレンダー限定の編集セッションが発行されて `/<ID>/edit` へ移動します。再発行すると旧リンクは無効になります
- `/admin` … 運営用の全体管理（導線なし）。アカウント一覧とアカウント削除のみ

ID（スラッグ）は英小文字・数字・ハイフン・アンダースコアの 3〜30 字で、`admin` / `login` / `signup` / `api` / `actions` / `owner` / `edit` などの予約語と、既存の ID は使えません。

### セキュリティの要点

- パスワードは平文で保存しません。ソルト付きハッシュ（PBKDF2-HMAC-SHA-256、12 万回、Web Crypto）で保存します。既知の初期パスワードは存在しません
- 編集リンクの UUID とセッショントークンは、DB には SHA-256 ハッシュだけを保存します。平文の編集リンクは発行時に一度だけ表示されます
- セッション cookie は HttpOnly + SameSite=Lax（HTTPS では Secure）、有効期限 30 日
- ログイン失敗が 5 回続くと、そのアカウントは 10 分間ロックされます（失敗回数は DB に記録）
- 編集リンクだけではパスワード変更はできません（現在のパスワードの照合が必須）。パスワード変更時は他のセッションを破棄します
- 公開 API の応答に、パスワードやトークンのハッシュ等の秘匿列は含まれません
- 管理者パスワードも同じハッシュ形式で保存し、未設定の間だけ最初に開いた管理者本人が設定できます

### カレンダーのテーマ

公開カレンダーの配色テーマを 6 種類（スタンダード／ウォーム／さくら／フォレスト／オーシャン／モノ）から選べます。テーマは `data-theme` 属性 + CSS 変数で実装され、公開画面と編集画面の両方に反映されます。

このリポジトリは Mac のローカル環境でそのまま動作確認できる構成になっています。本番の公開先は **Cloudflare Workers + D1** です（手順は後述）。

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

### 3. DB マイグレーションとデモデータ投入

```bash
bun run db:migrate
```

- `drizzle/` フォルダのマイグレーション SQL を適用し、`data/barber.db` を作成します。
- ローカル確認用に、店舗がまだ無い場合だけデモカレンダー 2 件（`/shop1`、`/shop2`）を投入します。**デモにはパスワードも編集リンクも設定されていないため、ログインも編集もできません**（公開カレンダーの見た目の確認専用です）。本番（Workers/D1）にはデモデータは入りません。

### 4. 開発サーバーを起動

```bash
bun run dev
```

`db:migrate` → クライアントのビルド → サーバー起動、までをまとめて行います。

### 5. ブラウザで確認

http://localhost:3000 を開いてください（ランディング）。新規登録から自分のカレンダーを作るか、デモの公開カレンダー（ http://localhost:3000/shop1 ）が見られます。

## 主なスクリプト

| コマンド | 内容 |
| --- | --- |
| `bun run dev` | マイグレーション → クライアントビルド → サーバー起動（http://localhost:3000） |
| `bun run start` | サーバーだけを起動（事前に `bun run build` と `bun run db:migrate` が必要） |
| `bun run build` | クライアントを `client/dist/` にビルド（`build:client` の別名） |
| `bun run build:client` | React バンドル + Tailwind CSS + index.html を `client/dist/` に生成 |
| `bun run db:migrate` | マイグレーション適用＋デモデータ投入（空の場合のみ） |
| `bun run typecheck` | client / server / worker の TypeScript 型チェック |
| `bun run dev:cf` | クライアントビルド → `wrangler dev`（Workers + ローカルD1 で起動） |
| `bun run db:migrate:cf:local` | ローカル D1 に `migrations/` を適用 |
| `bun run db:create:cf` | 本番用 D1 データベース `barber-db` を作成（初回のみ） |
| `bun run db:migrate:cf` | 本番 D1 に `migrations/` を適用 |
| `bun run deploy:cf` | クライアントビルド → `wrangler deploy`（本番公開） |

補足:

- サーバーは起動時にもマイグレーションを自動適用します（デモデータの投入はしません）。
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
│   │   └── icon.svg              # PWA アイコン
│   └── src/
│       ├── App.tsx       # 画面全体（ランディング・公開カレンダー・編集・認証・admin）
│       ├── main.tsx      # エントリポイント（React Query のセットアップ）
│       ├── api.ts        # サーバーへの型付き RPC クライアント（fetch）
│       ├── SafeArea.tsx  # スマホのセーフエリア用スクリム
│       └── theme.css     # Tailwind + テーマ変数（6テーマの配色定義）
├── server/
│   ├── worker.ts         # Cloudflare Workers の入口（D1 + 静的アセット配信）
│   ├── tsconfig.worker.json
│   └── src/
│       ├── index.ts      # Bun.serve（静的配信 + POST /actions、セッション cookie 処理）
│       ├── actions.ts    # 業務アクション（登録・ログイン・編集リンク・カレンダー・admin）
│       ├── framework.ts  # アクション定義・検証の小さなフレームワーク（zod）
│       ├── db.ts         # SQLite 接続とマイグレーション実行（Bun 用）
│       ├── migrate.ts    # `bun run db:m
...[truncated 2857 chars]