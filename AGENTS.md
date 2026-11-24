# Buppancho 開発規約

## 基準資料

- 業務仕様の唯一の正本は [現行仕様](spec/current-spec.md)。仕様変更はこの文書を更新し、増分ごとの別仕様書を作らない。
- 実装・検証・実機受入・正式利用への適用は [検証状況](docs/validation.md)、レビューは [レビュー手順](docs/review-guide.md) に集約する。
- アプリ名は「物販帳」、英語表記・識別子は「Buppancho」。UIは日本語。
- 通常販売は完了時1回入力。購入・配送・受取・費用配分・管理方式で業務を一般化し、特定業種・取引先の専用モードを作らない。
- 初期入力者は事業主・アパレル担当、部門は中国輸入・アパレル、申告主体は事業主1件、両部門を事業主へ割り当てる。編集・追加可能な初期値とし、入力者と帰属を混同しない。
- 税務判定・複式簿記・申告用集計は現行範囲に含めない。税務判断を推測せず、不明値は必須設定または確認事項にする。
- 変更単位で段階検証してから次へ進む。未実装・未検証を完了と報告しない。

## データと保存

- 既存DB・保存済み履歴・作業中ファイルを保全する。資料整理を業務データ・マイグレーション・ソースの削除理由にしない。
- テーブル名は英語snake_case、主キーはUUID、日時はUTC、画面はAsia/Tokyo。
- 金額は整数円／BigIntまたはDecimalを使い、JavaScript numberで金額計算しない。JSON境界は文字列とする。
- 在庫・販売・決済等の複合更新はDBトランザクションと冪等キーで処理し、保存結果と監査も同時に確定する。
- 確定データを物理削除・上書きしない。取消・反対処理・訂正履歴と監査ログを使う。
- 認証・ワークスペースをすべての読み書きで再検証する。部門・申告主体・年度を持つデータは帰属で限定し、検索・件数・名称取得も同じ境界を守る。
- 更新へZod検証、Origin確認、入力先確認、年度・版検証、監査を入れる。
- 共通部門ロックと在庫版更新を維持する。ワークスペース設定、部門ID順の在庫、対象行の共通ロック順を守る。
- 見込み費用を実費へ自動確定しない。不明と明示的な0円を区別する。
- 数量実測は日時・場所の帳簿数との差を固定保存し、遡及入力で実測値・調整数量を自動変更しない。差0に架空の移動を作らない。
- 後日入力・日付訂正は原価影響を確認し、元の移動・消費を保持して訂正を追記する。年度・帰属・ロック・同日順序を再検証する。
- 返品は元消費数量・訂正反映後原価を累計上限とし、最後の処理で端数を吸収する。返金未確認は途中保存までとし、現物返品・在庫も確定しない。
- 本人立替は申告主体の内部精算台帳とし、通常口座残高から除外する。元支払・充当履歴を保持し、取消は反対記録を使う。
- 履歴金額は保存済み明細から求め、過去の名称・単価・精算ルールは保存時のスナップショットを使う。お金の保存後の復帰先は同じアプリのお金一覧に限定する。

## 競合と結果不明

- 確定要求の再送・取消・照会を業務更新から分ける。結果不明を未保存と断定せず、先に元要求を照会する。
- 通信復帰や再開で業務確定を自動実行しない。同キー・同内容は同結果、別内容は拒否する。
- 競合の比較基準は不変とする。選び直しは元基準・元入力・理由を退避した新下書きだけを作り、保存・入庫・取消・返品を実行しない。
- 手元入力を保持し、自動マージ・他端末返品のコピー・数量や金額の自動減額をしない。
- 未解決の確定要求を先に照会・取消する。遅延要求は取消墓標で止める。

## コマンドと検証

- `pnpm dev`：開発サーバー。
- `pnpm db:deploy`：接続先を確認してマイグレーション適用。
- `pnpm bootstrap`：空DBへの初回ワークスペース・管理ログイン作成。
- コード変更では `pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm build` と対象E2Eを実行する。
- 現行の一括検証は `pnpm test:redesign:ui`。固定専用DBだけへ追加適用し、format・型・単体／DB統合・lint・build・PC／スマホ幅E2Eを行う。
- DBは `buppancho_redesign_20261110_test`、画面は独立3110または `BUPPANCHO_REDESIGN_UI_PORT=3112` 指定の3112。既存サーバーを再利用しない。詳細は検証状況を参照する。
- 通常DB・スマホDBへ自動切替しない。既存DBの削除・初期化・再seed、`docker compose down -v`、`prisma db push` を実行しない。
- 資料のみの変更はフォーマット、参照先、現行要件の整合性を確認する。業務コードの試験を再実行していない場合は明記する。
- DB接続拒否、ビルド権限エラー、失敗・スキップ・未実行を成功としない。同じ増分の手動確認依頼を繰り返さない。
- スマホ幅・PC幅・キーボード・日本語エラーを確認する。実機と人の入力時間の受入は自動試験と分ける。

## 変更と運用

- PrismaスキーマとマイグレーションSQLを同時に更新し、既存適用履歴とSQL制約・トリガーを保持する。
- 認証情報、Cookie、パスワード、秘密鍵をリポジトリ・ログ・監査JSONへ含めない。
- 正式利用はHTTPS・Secure Cookieを使い、DBポートを外部公開しない。
- バックアップ・復元は [運用手順](docs/backup-restore.md) に従い、復元先は別の空DBとする。
- 完了時は実行済み検証と未確認事項を検証状況へ反映して報告する。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
