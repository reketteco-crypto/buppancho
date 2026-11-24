# 物販帳（Buppancho）

購入・在庫・販売・お金を記録する日本語Webアプリです。数量商品・1点もの・資材・備品を同じ購入画面で扱い、通常販売は取引完了時に1回入力します。

## 資料

| 資料                                         | 役割                                     |
| -------------------------------------------- | ---------------------------------------- |
| [現行仕様](spec/current-spec.md)             | 業務仕様の唯一の正本                     |
| [開発規約](AGENTS.md)                        | 開発・データ保全・検証の制約             |
| [実装・検証状況](docs/validation.md)         | 自動検証、未確認事項、実機受入、確認画面 |
| [レビュー手順](docs/review-guide.md)         | レビュー対象の固定、操作例、依頼文       |
| [バックアップ・復元](docs/backup-restore.md) | 暗号化バックアップと別DBへの復元         |
| [更新・切り戻し](docs/update-rollback.md)    | 更新前確認と復旧                         |

## 主な操作

- **購入**：取引先・明細・数量・金額を記録し、受取・支払を任意で同時保存。外貨、配送・分割受取、追加費用、返金・返送も関連付けます。
- **商品**：在庫商品・販売商品（SKU）・資材／備品を各50件で表示。単品の一括登録、セット構成、販路別設定、基本情報の編集を行います。
- **販売**：完了時に販売する商品・販路・金額を確認して出庫と使用原価を保存。販売履歴CSV（メルカリ形式）と手入力のまとめ入力、返品・返金・費用・資材使用の追記に対応します。
- **お金**：通常口座・カード・本人立替、分割決済、振替、その他の費用・収入、入出金履歴を管理します。
- **設定**：日常の入力、事業・年度、運用に分けて、取引先、保管場所、販路、口座、入力先などを管理します。

購入・通常販売・販売まとめ入力はサーバーへ自動で途中保存します。ホームから入力を再開でき、販売・在庫・決済の確定は明示操作で行います。

不明金額と0円を区別し、訂正・取消を履歴へ追記します。購入・販売と実際の決済を分け、資材使用や立替精算で費用を二重計上しません。税務判定・仕訳・申告用集計は対象外です。

## 必要環境

- Windows 11、Docker Desktop（Compose v2）。
- ホストでの開発はNode.js 24、pnpm 11、PostgreSQL 18。正確な要件は `package.json` を参照してください。

アプリの動作に外部の有料サービスやOpenAI APIは使いません。

## 本番運用（このPC・同一LAN）

本番は `compose.production.yaml` の専用環境です。旧環境とテスト環境のDB・アカウントは引き継ぎません。アプリとDBのポートは公開せず、CaddyのHTTPS入口だけをプライベートLANへ公開します。

本番の環境ファイル・鍵・バックアップはリポジトリ外の `%LOCALAPPDATA%\Buppancho\production` に置きます。環境ファイルや秘密鍵をGitへ追加したり、内容をチャットへ貼り付けたりしないでください。

```powershell
$productionEnv = Join-Path $env:LOCALAPPDATA 'Buppancho\production\production.env'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/production.ps1 -Mode Status -EnvFile $productionEnv
```

初回構築は `-Mode Initialize -Release <検証済みの40桁Git SHA>`、更新は `-Mode Update -Release <同SHA>` を指定します。未コミットの変更がある場合や対象DBが違う場合は停止します。初回構築を既存DBへ再実行しません。

構築後、本人のターミナルで `-Mode Bootstrap` を実行してログイン名とパスワードを入力します。パスワードは非表示で扱います。PC・スマホの証明書登録、LAN設定、初期設定、復元確認が終わってから業務入力を始めてください。詳しくは [更新・起動と切り戻し](docs/update-rollback.md) と [バックアップ・復元](docs/backup-restore.md) を参照してください。

## 従来構成の初回起動

### 環境設定

```powershell
Copy-Item .env.example .env
```

`.env` の `POSTGRES_PASSWORD`、対応する `DATABASE_URL`、バックアップ保存先 `BACKUP_DIR`・`BACKUP_STATUS_DIR`・`BACKUP_MIRROR_DIR` を設定します。秘密値はGitへ追加しません。

### バックアップ鍵

```powershell
New-Item -ItemType Directory -Force secrets, backups, backup-status, backups-mirror
docker compose build backup
docker run --rm --entrypoint age-keygen --mount "type=bind,source=$((Resolve-Path secrets).Path),target=/keys" buppancho-backup -o /keys/backup-identity.txt
```

`secrets/backup-identity.txt` は秘密鍵です。Gitへ追加せず、別の安全な場所にも保管します。

### DBと初期ログイン

```powershell
docker compose up -d postgres
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm migrate pnpm bootstrap
```

bootstrapは空DBで一度だけ実行します。ワークスペース名、共通ログイン名、12文字以上のパスワードを対話入力し、パスワードは非表示で扱います。

### アプリ起動

```powershell
docker compose up -d app backup
docker compose ps
```

PCの入口は `http://localhost:3000`。ログイン後、編集可能な初期値「事業主」「アパレル担当」「中国輸入」「アパレル」と年度・申告主体・税務関連設定を確認します。申告主体は事業主1件、両部門を事業主の年度設定へ割り当てる初期構成です。

正式利用にはHTTPSを用意します。本番モードの認証CookieはSecureです。Composeのアプリ公開はloopback、DBは内部ネットワークに限定します。外部公開・スマホ実機への接続設定は別途確認し、検証状況の受入と分けて扱います。

## 開発

ホストで実行する場合：

```powershell
pnpm install
pnpm db:deploy
pnpm bootstrap
pnpm dev
```

DB適用とbootstrapは対象環境の初回準備時に行い、既存DBを初期化しません。

Dockerで開発する場合：

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres app
```

## 検証

```powershell
$env:BUPPANCHO_TEST_POSTGRES_PORT = '54320'
$env:BUPPANCHO_REDESIGN_UI_PORT = '3112'
$env:BUPPANCHO_REDESIGN_ISOLATED_BUILD = '1'
pnpm.cmd test:redesign:ui
```

固定専用DBへの追加適用、format、型、単体／DB統合、lint、build、PC／スマホ幅E2Eを実行します。既存データを保持し、独立サーバーを使います。上記設定では生成先も `.next-validation` へ分離します。専用DBがない場合は停止し、通常DBへ切り替えません。準備、実行済み結果、確認用3113、既知の問題は [検証状況](docs/validation.md) を参照してください。

個別確認は `pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm build`。DB統合と画面試験は、それぞれの環境・対象を確認して実行します。

## 運用

更新は [更新・切り戻し](docs/update-rollback.md)、復元は [バックアップ・復元](docs/backup-restore.md) を参照してください。

```powershell
docker compose down
```

DBボリュームを削除する `docker compose down -v` は実行しません。
