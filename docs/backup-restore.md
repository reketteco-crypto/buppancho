# バックアップと復元

更新日：2026-11-25。

## 新本番の保存と照合

新本番はリポジトリ外の `%LOCALAPPDATA%\Buppancho\production` に専用鍵・暗号化ファイル・状態を保存する。暗号化ファイルとチェックサムだけをOneDriveの `Buppancho/production-backups` へ複製する。鍵は別の安全な場所にも保管し、暗号化ファイルと同じ共有先へ置かない。

```powershell
$productionEnv = Join-Path $env:LOCALAPPDATA 'Buppancho\production\production.env'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/production.ps1 -Mode Backup -EnvFile $productionEnv
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/production.ps1 -Mode VerifyRestore -EnvFile $productionEnv
```

`Backup` は暗号化ファイル・チェックサムの作成と複製一致を確認する。OneDriveの同期完了や別端末からの取得可能性は別途確認する。チェックサムは同じフォルダーにあるファイル名を参照するので、複製先でも検証できる。

`VerifyRestore` はアプリ・HTTPS入口・定期バックアップを停止して新しいバックアップを取り、`buppancho_prod_restore_<UTC14桁>_test` という別の空DBへ復元する。件数・全列ハッシュ・シーケンス・制約・トリガー・関数を読み取りで照合し、一致後だけアプリを再開する。復元先を保全し、既存DBを上書き・削除しない。失敗時は停止を維持する。

同じ本番イメージを復元DBへ接続し、readinessと匿名のログイン画面も確認する。この確認用コンテナーはホスト・LANへポートを公開せず、確認後に停止する。認証成功や認証後の主要画面の受入は、このHTTP確認の成功に含めない。

CHECK制約の再解析で同じAND／OR条件の括弧が変わる場合は、同一演算子の結合だけを読み取り側で正規化する。条件順・ANDとORの組み合わせ・値・SQL文字列・検証／遅延／強制の状態は保持して比較する。制約を削除・再定義して一致させない。更新・復元が未完了の間はbootstrapも停止する。

初期設定後に実行し、復元側のログイン・主要画面の確認と月1回の復元確認を記録する。保存済みデータの照合を先に終え、復元側の確認操作によるセッション更新等と混同しない。

バックアップはDBの起動を最大約1分待ち、失敗時は5分後に再試行する。成功後は24時間間隔とし、日次14日・月次12か月の保持を維持する。成功状態でも日時が古い場合は、PCの稼働・定期処理・OneDrive同期を確認する。

## 従来構成

## 方式と鍵

PostgreSQLのカスタム形式dumpをageの公開鍵で暗号化する。秘密鍵は `secrets/backup-identity.txt`、コンテナ内は `/run/secrets/backup-identity`。初回生成は [README](../README.md) を参照する。

秘密鍵をGit・ログへ含めず、別の安全な場所へ保管する。秘密鍵がなければ復号できない。

起動時と以降24時間ごとにバックアップする。日次14日、毎月1日分を月次12か月保持する。保存先・複製先は `BACKUP_DIR`・`BACKUP_MIRROR_DIR`、状態記録は `BACKUP_STATUS_DIR`。暗号化ファイルにはSHA-256チェックサムを付ける。

状態はDB外のJSONへ記録し、設定のバックアップ画面で成功・失敗を確認する。

## 手動バックアップ

```powershell
docker compose run --rm --entrypoint /usr/local/bin/buppancho-backup backup
```

終了結果、状態記録、暗号化ファイル・チェックサム、別保存先への複製を確認する。実装は `scripts/backup/backup.sh` と `scripts/backup/loop.sh`。

## 別の空DBへの復元

1. 通常DB・スマホDBとは別の空DBを用意する。
2. 接続先を `TARGET_DATABASE_URL`、パスワードを `TARGET_POSTGRES_PASSWORD` としてターミナルの環境に設定する。値をチャットやログへ出さない。
3. コンテナから接続できるDBであることと、暗号化ファイル・チェックサム・秘密鍵を確認する。
4. 次のファイル名を対象へ置き換える。環境変数名だけを渡し、値をコマンドへ埋め込まない。

```powershell
docker compose run --rm -e TARGET_DATABASE_URL -e TARGET_POSTGRES_PASSWORD --entrypoint /usr/local/bin/buppancho-restore backup /backups/daily/buppancho-YYYYMMDDTHHMMSSZ.dump.age
```

`scripts/restore/restore.sh` はチェックサムと復元先publicテーブルの空状態を検証し、空でなければ停止する。稼働DBを復元先にしない。

復元後は件数、全列ハッシュ、シーケンス、入力先・年度割当、ログイン、主要な取引・在庫・決済を照合する。検証用コードは `scripts/test/verify-restored-db.ts` を参照する。復元成功とアプリの利用確認を分けて記録する。

月1回の復元確認を運用上の目標とする。実施・未確認は [検証状況](validation.md) に記録する。
