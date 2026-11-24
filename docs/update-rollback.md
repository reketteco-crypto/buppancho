# 更新と切り戻し

更新日：2026-11-25。

## 本番構成と開始条件

このPCの専用Compose `compose.production.yaml`、プロジェクト `buppancho-prod`、DB・ロール `buppancho_prod` を使う。旧DB・テストDBのレコードはコピーしない。アプリとDBは内部ネットワーク、Caddyだけを `https://192.168.11.12:3443` で公開する。IPは実環境の `LAN_ADDRESS` と一致させ、ルーターのDHCP予約で固定する。

本番の環境ファイルは `%LOCALAPPDATA%\Buppancho\production\production.env`。専用の64桁ランダムhex DBパスワード、固定digest付きCaddyイメージ、絶対パスのバックアップ・複製・鍵保存先を設定する。秘密情報はリポジトリ外に置く。

```powershell
$productionEnv = Join-Path $env:LOCALAPPDATA 'Buppancho\production\production.env'
$productionRelease = git rev-parse HEAD
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/production.ps1 -Mode Initialize -EnvFile $productionEnv -Release $productionRelease
```

検証・コミット済みのクリーンな作業ツリーだけを配備する。初回は空状態を確認し、ビルド、マイグレーション、アプリ起動、暗号化バックアップ・複製、HTTPS入口の起動を行う。DBポートはホストにもLANにも公開しない。

本人が対話式ターミナルで次を実行し、ログイン名と12文字以上のパスワードを決める。パスワードをコマンド引数や環境ファイルへ書かない。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/production.ps1 -Mode Bootstrap -EnvFile $productionEnv
```

ブラウザーで初期設定を完了する。初期候補は事業主・アパレル担当、中国輸入・アパレル、事業主1件への年度割当。税務関連の必須設定は本人が確認して選び、既定値を推測して確定しない。開始在庫・残高・過去CSVの登録は別途行う。

### PC・スマホのHTTPSとLAN設定

1. 本番Caddyの `/data/caddy/pki/authorities/local/root.crt` から**公開証明書だけ**を取り出す。秘密鍵を端末へ配布しない。ファイルは本番の `certificates` フォルダーに保管し、SHA-256を控える。
2. PCでは公開証明書を `Cert:\CurrentUser\Root` へ登録する。Chrome／Edgeで警告が出ないことを確認する。
3. iPhone／iPadは公開証明書を安全に転送してプロファイルをインストールし、「設定 → 一般 → 情報 → 証明書信頼設定」で該当ルートの完全な信頼を有効にする。Androidは設定の証明書インストールからCA証明書を登録する。OSで名称が異なる場合は、端末の案内で確認する。
4. 管理者として開いたPowerShellで次を実行する。プライベートLAN・現在のIPを確認し、同一LANから3443/TCPだけを許可する。ルールは `Buppancho-Production-HTTPS`。既存ルールを自動的に広げない。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/enable-lan.ps1 -LanAddress 192.168.11.12
```

5. スマホを同一Wi-Fiへ接続し、`https://192.168.11.12:3443` を開く。証明書警告、ログイン、入力欄、キーボード、自動保存・再開を実機で確認する。ゲストWi-Fiの端末間隔離などで接続できない場合はネットワーク側を確認する。ルーターのポート転送は設定しない。

### 今回のPCとAndroidで行う手順

証明書は、このPC内で作った物販帳用の発行元をブラウザーに登録するためのもの。アプリのログイン名・パスワードとは別で、公開証明書には秘密鍵や業務データを含めない。

**PC**：エクスプローラーで `%LOCALAPPDATA%\Buppancho\production\certificates` を開き、`Buppancho-root.cer` をダブルクリックする。「証明書のインストール」→「現在のユーザー」→保存先を指定→「信頼されたルート証明機関」を選ぶ。最後の確認では、証明書名が `Caddy Local Authority - 2026 ECC Root` で、今回作成した証明書の拇印と一致することを確認して本人が承認する。内容を判断できない場合は「いいえ」で閉じてよい。画面を閉じても業務データは変わらない。

**Android**：次の順で公開証明書を登録する。

1. 自分のOneDriveの `Buppancho/device-setup/Buppancho-root.cer` をスマホへダウンロードする。秘密鍵ファイルは使わない。
2. Androidの設定で「証明書」を検索し、「証明書をインストール」→「CA証明書」を選び、ダウンロードしたファイルを指定する。Pixel系では「セキュリティとプライバシー」→「その他のセキュリティ設定」→「暗号化と認証情報」から進める。端末のロック解除や確認は本人が行う。
3. このPCと同じWi-Fiにつなぎ、Chromeで `https://192.168.11.12:3443` を開く。警告を無視して進まず、警告が出ないことを確認してからログインする。開けない場合は、PCの稼働、LANルール、Wi-Fiの端末間隔離、IP予約を確認する。

証明書の名前が分かりづらい場合でも、ダウンロード元と拇印を確認せず、別の証明書を追加しない。登録先や設定名はAndroidの機種・版によって異なる。

### 起動・停止・更新

`production.ps1` の `-Mode Status` でDB・適用履歴・初期設定・バックアップ状態を確認する。`Start` は適用済みマイグレーションを照合して起動し、DB更新を実行しない。`Stop` はアプリとHTTPS入口を止める。

Windowsサインイン後の自動起動には `start-on-login.ps1 -EnvFile <本番環境ファイル>` のショートカットをユーザーのスタートアップへ配置する。Docker Desktopの起動を待ってから本番だけを起動する。結果は本番フォルダーの `startup.log`。PC停止・スリープ中と、再起動からWindowsサインインまでの利用は保証しない。

更新は `-Mode Update -Release <検証済みGit SHA>`。ビルド後にアプリ・入口・定期バックアップを停止し、更新前バックアップ・複製、マイグレーション、起動の順で実行する。成功時に配備SHAを環境ファイルへ記録する。

未完了の更新・復元確認は `backup-status/operation.pending` を残し、自動起動を止める。入口もこのマーカーを確認し、再起動された場合も503応答で入力を止める。失敗時はログ、元要求、適用履歴と保存データを照合する。このファイルを無条件で削除したり、初期化や逆マイグレーションで回避しない。安全を確認した復旧担当者だけが解除して明示起動する。

初回運用版に、互換性を確認済みの前本番版はない。旧環境の9月版を新本番DBへ向けない。障害時は入力を止めて修正版を配備するか、別空DBへの復元・照合後に接続先を切り替える。今後の更新では直前のイメージSHAとDB互換性を確認してからアプリを戻す。

## 従来構成

## 更新前

対象コード・DB・マイグレーションと停止時間を確認する。業務仕様は [現行仕様](../spec/current-spec.md)、実施済み試験と正式利用への適用は [検証状況](validation.md) を参照する。

更新前バックアップの成功が必須。失敗時は更新へ進まず、暗号化ファイル・鍵・復元先を確認する。手順は [バックアップと復元](backup-restore.md)。

## 更新

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy/update.ps1
```

スクリプトはバックアップ、app／migrateイメージ作成、マイグレーション、サービス更新の順で実行する。各Dockerコマンドの終了コードを確認し、非ゼロならスクリプトも非ゼロで終了して後続を実行しない。起動後はヘルスチェック、ログイン、代表操作、バックアップ状態を確認する。

停止動作は `tests/unit/deploy-update.test.ts` でバックアップ・build・migrate・upの失敗をモックして確認する。試験の成功は、実環境への更新・切り戻しの実施を意味しない。

DB更新は追加マイグレーションを使い、履歴を上書き・初期化しない。PostgreSQLのメジャー更新は別のdump／restore作業とする。

## 切り戻し

- アプリだけを戻す場合は、DBとの互換性を確認して以前のイメージタグへ戻す。
- データを戻す場合は、別の空DBへ復元・照合してから停止時間を確保して切り替える。
- 稼働DBへの上書き復元、名前付きボリュームの削除、無条件の逆マイグレーションを行わない。

正式利用はHTTPSとアプリ内認証を使い、DBポートを外部公開しない。Composeのtunnel profileは任意の接続構成であり、有効化・外部アクセスの受入が済んだことを意味しない。
