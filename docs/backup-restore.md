# バックアップと復元

バックアップはPostgreSQLカスタム形式を`age`のパスフレーズ方式で暗号化します。日次14世代、毎月1日分を12か月保持します。

## 初期準備

1. READMEの手順で`secrets/backup-identity.txt`を生成し、リポジトリ外の安全な場所へ秘密鍵を複製する。
2. このファイルをGitへ追加しない。復元不能を避けるため、別の安全な場所にも保管する。
3. `.env`の`BACKUP_DIR`、`BACKUP_STATUS_DIR`、`BACKUP_MIRROR_DIR`を実在する保存先へ変更する。

## 手動バックアップ

```powershell
docker compose run --rm --entrypoint /usr/local/bin/buppancho-backup backup
```

## 復元

復元スクリプトは空DB以外を拒否します。本番DBを復元先に指定しないでください。

```powershell
docker compose run --rm --entrypoint /usr/local/bin/buppancho-restore backup /backups/<file>.dump.age
```

実際には検証用DBの`TARGET_DATABASE_URL`と`TARGET_POSTGRES_PASSWORD`を環境変数として渡します。復元後はテーブル件数、ワークスペース、年度割当、ログインを確認します。月1回実施してください。
