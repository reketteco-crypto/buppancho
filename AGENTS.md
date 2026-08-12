# Buppancho 開発規約

## 基準仕様と範囲

- `spec/resale_management_implementation_spec.md`を基準仕様とする。初期データの表示名・件数・帰属は`docs/architecture-decisions.md`に記録したユーザー指定を優先する。
- アプリ名は「物販帳」、英語表記・識別子は「Buppancho」。UIは日本語。
- 実装フェーズを飛ばさない。現在の実装済み範囲はフェーズ0のみ。
- 税務判断を推測で実装しない。不明値は必須設定または確認事項にする。

## 永続データ

- テーブル名は英語`snake_case`、主キーはUUID、日時はUTC、画面は`Asia/Tokyo`。
- 金額は整数円またはDecimalを使い、JavaScript `number`で金額計算しない。
- 在庫・販売・会計の複合更新は将来必ずDBトランザクションと冪等キーを使う。
- 確定データを物理削除しない。取消・反対処理と監査ログを使う。
- ワークスペース境界と認証をすべての読み書きで再検証する。

## 主要コマンド

- `pnpm dev`: 開発サーバー
- `pnpm db:deploy`: マイグレーション適用
- `pnpm bootstrap`: 最初のワークスペースと管理ログイン作成
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`: 必須検証
- `pnpm test:e2e`: Playwright画面検証
- `docker compose --profile tools run --rm migrate`: Compose経由のマイグレーション

## 変更時の確認

- PrismaスキーマとマイグレーションSQLを同時に更新する。
- 認証情報、Cookie、パスワード、秘密鍵をログや監査JSONへ含めない。
- 更新処理へZod検証、Origin確認、認証、workspaceスコープ、監査記録を入れる。
- スマホ幅、PC幅、キーボード操作、日本語エラーを確認する。
- フェーズ完了時に実行済みテストと未確認事項を報告する。
