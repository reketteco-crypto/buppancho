# 物販帳（Buppancho）

夫婦2名で使う、物販・在庫・会計管理Webアプリです。基準仕様は`spec/resale_management_implementation_spec.md`です。

現在は**フェーズ0: 基盤**のみ実装しています。商品、仕入れ、在庫、SKU、販売、経費、仕訳はまだ実装していません。

仕様にない細部の判断と理由は`docs/architecture-decisions.md`に記録しています。

## フェーズ0でできること

- 共通アカウントによるセッション認証とログイン試行制限
- ワークスペース、入力者、申告主体、販売部門、会計年度の初期設定
- 任意数の入力者・申告主体・販売部門と、主な入力者・申告主体の年度別割当
- 前年度から翌年度への設定コピーと、決算処理中・ロック済み状態の管理
- 現在の入力者、販売部門、対象年度の切り替え
- 設定変更の監査ログ
- PC・スマートフォン対応の日本語UIとPWA基本設定
- PostgreSQL日次暗号化バックアップと空DBへの復元手順

## 必要環境

- Windows 11
- Docker Desktop（Compose v2を含む）
- 開発用に直接実行する場合はNode.js 24 LTS、pnpm 11、PostgreSQL 18

外部の有料サービスやOpenAI APIは使いません。Cloudflare Tunnelはフェーズ0では設定・公開せず、任意profileの雛形だけを含めています。

## 初回起動（Docker Compose）

### 1. 環境ファイル

```powershell
Copy-Item .env.example .env
```

`.env`の少なくとも次を変更します。

- `POSTGRES_PASSWORD`: 長いランダム値
- `DATABASE_URL`: 上と同じパスワードを含む接続先
- `BACKUP_DIR`、`BACKUP_STATUS_DIR`: 実在する保存先
- `BACKUP_MIRROR_DIR`: 可能なら別ドライブまたは別端末の保存先

`.env`と実際の秘密値はGitへ追加しません。

### 2. バックアップ暗号化鍵

```powershell
New-Item -ItemType Directory -Force secrets, backups, backup-status, backups-mirror
docker compose build backup
docker run --rm --entrypoint age-keygen --mount "type=bind,source=$((Resolve-Path secrets).Path),target=/keys" buppancho-backup -o /keys/backup-identity.txt
```

`backup-identity.txt`は秘密鍵です。このファイルもGitへ追加せず、リポジトリ外の安全な場所へ複製してください。紛失するとバックアップを復号できません。

### 3. DB起動とマイグレーション

```powershell
docker compose up -d postgres
docker compose --profile tools run --rm migrate
```

### 4. 最初の管理ログイン

```powershell
docker compose --profile tools run --rm migrate pnpm bootstrap
```

対話入力でワークスペース名、共通ログイン名、12文字以上のパスワードを設定します。パスワードは画面へ表示されず、Argon2idハッシュだけがDBへ保存されます。bootstrapは空DBで一度だけ実行できます。

### 5. アプリ起動

```powershell
docker compose up -d app backup
docker compose ps
```

ブラウザーで `http://localhost:3000` を開きます。ログイン後、初期表示される「事業主」「アパレル担当」「中国輸入」「アパレル」を必要に応じて編集・追加し、対象年度、申告主体、消費税区分、控除目標、棚卸評価方法を確認して初期設定を完了します。初期状態では両部門を事業主の年度設定へ割り当てます。

本番相当運用ではHTTPS URLを使ってください。本番モードの認証Cookieは`Secure`であり、平文LAN HTTPをスマートフォンへ公開しません。

## 開発環境

Docker内で開発サーバーを使う場合:

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres app
```

ホストで直接実行する場合:

```powershell
pnpm install
pnpm db:deploy
pnpm bootstrap
pnpm dev
```

開発用ComposeだけがPostgreSQLを`127.0.0.1:5432`へ公開します。本番構成ではDBポートを公開しません。

## 検証

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
docker compose config --quiet
```

PostgreSQLを使う検証では、先にテストDBへマイグレーションを適用します。手動確認項目は`docs/phase0-manual-check.md`にあります。

## バックアップ

バックアップサービスは起動後と以降24時間ごとに`pg_dump`を実行し、`age`で暗号化します。日次14日、毎月1日分12か月を保持します。

手動実行:

```powershell
docker compose run --rm --entrypoint /usr/local/bin/buppancho-backup backup
```

復元は既存データの誤上書きを防ぐため、空の検証DBだけを受け付けます。詳細は`docs/backup-restore.md`を参照してください。

## 更新

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy/update.ps1
```

更新前バックアップに失敗した場合は処理を中止します。切り戻し方針は`docs/update-rollback.md`にあります。

## 停止

```powershell
docker compose down
```

この操作ではPostgreSQLの名前付きボリュームを削除しません。`docker compose down -v`はDBを削除するため、通常運用では実行しないでください。

## セキュリティと運用上の注意

- 共通ログインでは、実際の操作者は画面で選んだ「入力者」の自己申告です。入力前に画面上部を確認してください。
- Cloudflare Accessを将来追加しても、アプリ内認証を省略しません。
- 確定データの物理削除を前提にしません。フェーズ0の設定も無効化と監査履歴を基本にします。
- 金額フィールドはまだありません。後続フェーズでは整数円またはDecimalのみを使用し、JavaScript `number`で金額計算しません。
- 税務上の申告方式・帰属・評価方法を物販帳が自動判断することはありません。
