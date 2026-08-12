# 物販・在庫・会計管理アプリ 実装仕様書

文書版: 1.0  
作成日: 2026-07-25  
対象: Codexによる設計・実装  
運用形態: 夫婦2名による自家利用、将来の一般提供を妨げない構造

---

## 0. この文書の使い方

この文書は、物販の仕入れ、在庫、出品、販売、利益、複式簿記を一体管理するWebアプリを実装するための基準仕様である。

Codexは、最初から全機能を一括実装せず、「16. 実装フェーズ」の順に実装すること。各フェーズで以下を行い、テストが通ってから次へ進むこと。

1. データベース変更
2. サーバー処理
3. 画面
4. 自動テスト
5. 手動確認手順の記録

仕様に明記されていない事項は、データ損失を防ぎ、後方互換性を維持する方向で判断する。税務判断をアプリが自動決定してはならない。

---

## 1. 目的

### 1.1 解決する課題

- メルカリで販売する商品の仕入れから売上、利益までを一元管理する。
- 中国輸入商品の数量在庫と、古着1着ごとの個体在庫を同じアプリで管理する。
- 複数の仕入商品を組み合わせたセットSKUを販売できるようにする。
- 本人の青色申告に必要な複式簿記と決算集計を作成する。
- 妻の白色申告用の収支集計にも対応する。
- 「本人・中国輸入」「妻・アパレル」という販売部門と、所得を申告する人を分けて管理する。
- Rakumartの預け金、人民元、為替、送料、関税等を含む実際原価を管理する。
- 外出先のスマートフォンから入力できるようにする。
- 現在使用しているマネーフォワード確定申告から残高・仕訳を移行できるようにする。

### 1.2 成功条件

- 通常の販売登録がスマートフォンで30秒以内に完了する。
- 通常の経費登録がスマートフォンで20秒以内に完了する。
- 数量在庫、個体在庫、セットSKUの在庫が二重減算されない。
- 商品別、部門別、販路別、月別の概算利益を確認できる。
- 仕入総額と各商品への原価配賦額が必ず一致する。
- 帳簿残高、在庫評価額、販路売上金残高の根拠を元取引まで追跡できる。
- 本人と妻の申告データが重複計上されない。
- バックアップから別環境へ復元できる。

### 1.3 初期版で行わないこと

- 個人向けメルカリ画面のスクレイピングや非公式API利用
- メルカリへの自動出品・自動値下げ・自動メッセージ
- 所得税確定申告書全体の作成
- e-Taxへの直接送信
- 医療費、生命保険、ふるさと納税等の個人所得控除管理
- インボイス登録事業者向けの完全な消費税申告
- アプリ内の商品画像・領収書画像アップロード
- オフライン状態でのデータ更新
- 多数の一般顧客を収容するSaaS課金機能

---

## 2. 重要な設計原則

### 2.1 アプリは夫婦共通仕様とする

本人用と妻用で別アプリを作らない。以下を分離する。

- `利用者`: 誰が入力したか
- `販売部門`: どの物販活動の成績か
- `申告主体`: 誰の帳簿・申告集計へ含めるか
- `申告方式`: 青色または白色。申告主体・年度単位で設定する

初期データ:

- 販売部門A: 本人・中国輸入
- 販売部門B: 妻・アパレル
- 申告主体A: 本人
- 申告主体B: 妻
- 2026年の割当: 中国輸入 → 本人、アパレル → 妻

妻のアパレルを将来本人の事業に含める場合は、対象年度の部門割当を本人へ変更する。日々の入力時に申告主体を毎回選ばせない。管理者だけが例外的に変更できる。

注意: 所得の帰属は任意に選べるものではなく、実際の経営実態に基づく。アプリは設定機能のみ提供し、税務判断は行わない。

### 2.2 事実データと会計データを分離する

- 仕入、入庫、販売、発送、入金等を「業務上の事実」として保存する。
- 事実を基に自動仕訳を生成する。
- 自動仕訳を修正しても元取引を失わない。
- 同一イベントから同じ仕訳を二重生成しない。

### 2.3 在庫は移動履歴を正とする

現在庫数を直接書き換えない。在庫移動の合計から現在庫を算出する。

在庫移動例:

- 入庫
- 販売引当
- 販売出庫
- 引当解除
- 返品入庫
- 廃棄
- 紛失
- 私用
- 棚卸調整
- 部門間移動

### 2.4 確定済みデータを物理削除しない

- 下書きは削除可能。
- 確定取引は取消・反対処理で戻す。
- 確定仕訳は反対仕訳で訂正する。
- すべての重要操作に作成者、更新者、日時を記録する。

### 2.5 金額計算に浮動小数点を使わない

- 円貨の確定額: 整数円
- 人民元、為替レート、重量、配賦計算: Decimal型
- JavaScriptの`number`による金額計算は禁止
- 端数は配賦単位ごとの規則に従い、差額を決定的に処理する

---

## 3. 用語

| 用語 | 定義 |
|---|---|
| ワークスペース | この家庭が使用するアプリ内の最上位データ領域 |
| 利用者 | 本人または妻。共通ログインでも入力者として記録する |
| 申告主体 | 所得と帳簿が帰属する人 |
| 販売部門 | 中国輸入、アパレル等の管理上の活動単位 |
| 在庫商品 | 物理的に保有する商品の種類または個体 |
| 仕入ロット | 同一条件で仕入れた在庫のまとまり |
| 個体 | 古着等、1点単位で識別する在庫 |
| 販売SKU | 顧客へ販売する商品単位。単品またはセット |
| セット構成 | 販売SKUを構成する在庫商品と必要数量 |
| 出品 | 特定販路での価格、URL、状態を持つ販売情報 |
| 注文 | 販売が成立した取引 |
| 販路残高 | メルカリ等に留保されている売上金 |
| 管理原価 | 商品別利益を日常表示するための原価 |
| 税務在庫評価 | 年末棚卸・決算に使用する評価額 |

---

## 4. 推奨技術構成

### 4.1 アプリケーション

- フルスタック: Next.js App Router + TypeScript
- UI: Tailwind CSS + アクセシブルなコンポーネントライブラリ
- データベース: PostgreSQL
- ORM・マイグレーション: Prisma
- 入力検証: Zod
- 金額計算: Decimal.jsまたはORMのDecimal
- 認証: メールアドレスまたはユーザー名 + パスワードのセッション認証
- テスト: Vitest + Playwright
- 配布: Docker Compose
- スマートフォン: PWA対応

ライブラリのバージョンは実装開始時の安定版を固定し、ロックファイルをコミットする。

### 4.2 自宅運用

構成:

- Windowsパソコン上でDocker Composeを常時起動
- `app`コンテナ
- `postgres`コンテナ
- 任意で`cloudflared`コンテナ
- Cloudflare Tunnel + Accessで外部公開
- ルーターの受信ポートは開放しない

### 4.3 PWA・オフライン方針

- ホーム画面追加に対応する。
- アプリの外枠と静的アセットのみキャッシュする。
- 会計・在庫更新はオンライン時のみ許可する。
- オフライン時は読み取り済み画面の表示に限定し、「通信復旧後に再試行」と表示する。
- 書き込みリクエストの自動再送は行わない。二重登録の原因になるためである。

### 4.4 初期認証

- アプリ内アカウントは1つでもよいが、入力者として本人・妻を選択する。
- パスワードはArgon2id等でハッシュ化し、平文保存しない。
- Cookieは`HttpOnly`、`Secure`、`SameSite=Lax`以上とする。
- ログイン失敗回数を制限する。
- Cloudflare Accessのメールワンタイムコードを外側の認証として推奨する。

---

## 5. データモデル

以下は論理モデルである。テーブル名は英語snake_caseとする。主キーはUUID、日時はUTC保存、画面表示はAsia/Tokyoとする。

### 5.1 組織・設定

#### workspace

- id
- name
- timezone (`Asia/Tokyo`)
- base_currency (`JPY`)
- created_at / updated_at

#### operator

- id
- workspace_id
- display_name
- active
- created_at / updated_at

初期値: 本人、妻。

#### user_account

- id
- workspace_id
- login_name
- password_hash
- active
- last_login_at

#### reporting_entity

- id
- workspace_id
- display_name
- entity_type (`individual`)
- active

初期値: 本人、妻。

#### fiscal_year_profile

- id
- reporting_entity_id
- year
- filing_method (`blue`, `white`)
- consumption_tax_status (`exempt`, `taxable`, `invoice_registered`)
- blue_deduction_target (`none`, `100k`, `550k`, `650k`)
- inventory_valuation_method
- start_date / end_date
- status (`open`, `closing`, `locked`)
- locked_at

同じ申告主体・年度の組み合わせは一意。

#### business_unit

- id
- workspace_id
- code
- name
- color
- default_operator_id nullable
- active

#### business_unit_assignment

- id
- business_unit_id
- fiscal_year_profile_id
- effective_from
- effective_to

同一日付で複数の申告主体へ割り当ててはならない。

### 5.2 共通マスター

#### sales_channel

- id
- workspace_id
- name
- type (`mercari`, `rakuma`, `yahoo_fleamarket`, `mercari_shops`, `amazon`, `yahoo_shopping`, `other`)
- default_fee_rate
- default_shipping_payer
- active

#### storage_location

- id
- workspace_id
- business_unit_id nullable
- code
- name
- active

#### counterparty

- id
- workspace_id
- name
- type (`supplier`, `customer`, `agent`, `carrier`, `other`)
- currency
- memo

初期値にRakumartを含める。

#### payment_account

- id
- reporting_entity_id
- name
- type (`cash`, `bank`, `credit_card`, `channel_balance`, `agent_deposit`, `other`)
- currency
- accounting_account_id nullable
- active

### 5.3 商品・在庫

#### inventory_item

- id
- workspace_id
- business_unit_id
- item_code
- name
- category
- management_type (`quantity`, `unique`)
- default_storage_location_id nullable
- management_cost_method (`moving_average`, `fifo`, `specific`)
- status (`active`, `inactive`)
- memo

`unique`の場合、管理原価方式は`specific`固定。

#### item_variant

- id
- inventory_item_id
- variant_code
- attributes_json
- active

例: 色、サイズ、型番。

#### inventory_lot

- id
- item_variant_id
- purchase_line_id nullable
- received_date
- received_quantity
- remaining_quantity
- landed_cost_total_jpy
- unit_cost_jpy
- cost_status (`provisional`, `final`)
- storage_location_id

`remaining_quantity`はキャッシュとして保持してもよいが、在庫移動合計と定期照合する。

#### unique_stock_unit

- id
- item_variant_id
- inventory_lot_id
- individual_code
- condition
- measurements_json
- acquisition_cost_jpy
- storage_location_id
- status (`in_stock`, `reserved`, `sold`, `returned`, `disposed`, `lost`, `personal_use`)
- memo

`individual_code`はワークスペース内で一意。

#### stock_movement

- id
- item_variant_id
- inventory_lot_id nullable
- unique_stock_unit_id nullable
- movement_type
- quantity
- movement_at
- business_unit_id
- storage_location_from_id nullable
- storage_location_to_id nullable
- source_type
- source_id
- idempotency_key
- operator_id
- note

`idempotency_key`は一意。数量管理は正数・負数で移動を表現する。

### 5.4 仕入れ・Rakumart

#### purchase

- id
- workspace_id
- business_unit_id
- reporting_entity_id
- supplier_id
- purchase_type (`domestic`, `rakumart_import`, `used_bundle`, `other`)
- order_number nullable
- ordered_at
- accounting_recognition_date nullable
- currency
- exchange_rate nullable
- status (`draft`, `ordered`, `paid`, `partially_received`, `received`, `costing`, `finalized`, `cancelled`)
- memo

#### purchase_line

- id
- purchase_id
- item_variant_id nullable
- source_name
- source_url nullable
- ordered_quantity
- received_good_quantity
- defective_quantity
- shortage_quantity
- unit_price_foreign nullable
- product_amount_foreign nullable
- product_amount_jpy
- weight_grams nullable
- volume nullable
- manually_allocated_cost_jpy nullable
- final_landed_cost_jpy nullable

#### purchase_charge

- id
- purchase_id
- charge_type (`china_domestic_shipping`, `agent_fee`, `inspection`, `international_shipping`, `customs_duty`, `import_consumption_tax`, `japan_shipping`, `payment_fee`, `other`)
- amount_foreign nullable
- currency
- amount_jpy
- allocation_method (`quantity`, `product_value`, `weight`, `volume`, `manual`, `non_inventory_expense`)
- accounting_treatment

#### purchase_charge_allocation

- id
- purchase_charge_id
- purchase_line_id
- allocated_amount_jpy

配賦合計は元費用と一致しなければならない。

#### agent_deposit_transaction

- id
- payment_account_id
- business_unit_id
- transaction_type (`deposit`, `purchase_use`, `fee_use`, `refund`, `adjustment`)
- occurred_at
- amount_foreign nullable
- currency
- amount_jpy
- exchange_rate nullable
- purchase_id nullable
- note

### 5.5 販売SKU・出品

#### sales_sku

- id
- workspace_id
- business_unit_id
- sku_code
- name
- sku_type (`single`, `bundle`)
- description nullable
- expected_price_jpy nullable
- active

#### sales_sku_component

- id
- sales_sku_id
- item_variant_id nullable
- unique_stock_unit_id nullable
- required_quantity

単品SKUも構成行を1件持つ。セットSKUの在庫数は構成品の販売可能数から計算する。

#### listing

- id
- sales_sku_id
- sales_channel_id
- external_listing_id nullable
- url nullable
- listed_at
- current_price_jpy
- listed_quantity
- reserved_quantity
- expected_shipping_jpy nullable
- fee_rate nullable
- status (`draft`, `active`, `paused`, `sold_out`, `ended`)

#### listing_price_history

- id
- listing_id
- price_jpy
- effective_at
- reason nullable
- operator_id

### 5.6 販売・発送・入金

#### sales_order

- id
- workspace_id
- business_unit_id
- reporting_entity_id
- sales_channel_id
- external_order_id nullable
- ordered_at
- completed_at nullable
- accounting_recognition_date nullable
- status (`draft`, `confirmed`, `awaiting_shipment`, `shipped`, `awaiting_completion`, `completed`, `cancelled`, `returned`)
- gross_sales_jpy
- discount_jpy
- fee_jpy nullable
- shipping_jpy nullable
- packing_jpy nullable
- other_cost_jpy nullable
- channel_net_receivable_jpy nullable
- cost_status (`provisional`, `final`)
- memo

#### sales_order_line

- id
- sales_order_id
- listing_id nullable
- sales_sku_id
- quantity
- unit_price_jpy
- allocated_discount_jpy
- management_cogs_jpy nullable

#### order_component_consumption

- id
- sales_order_line_id
- item_variant_id
- inventory_lot_id nullable
- unique_stock_unit_id nullable
- quantity
- unit_cost_jpy
- cost_status (`provisional`, `final`)

このテーブルが、販売時に実際に消費したロット・個体の証跡となる。

#### shipment

- id
- sales_order_id
- shipped_at nullable
- shipping_method nullable
- tracking_number nullable
- actual_shipping_jpy nullable
- status (`pending`, `shipped`, `delivered`, `returned`)

#### channel_balance_transaction

- id
- payment_account_id
- sales_order_id nullable
- type (`sale`, `fee`, `shipping`, `refund`, `payout`, `adjustment`)
- occurred_at
- amount_jpy
- external_reference nullable
- idempotency_key

#### payout

- id
- channel_payment_account_id
- destination_payment_account_id
- requested_at nullable
- paid_at
- gross_amount_jpy
- transfer_fee_jpy
- net_deposit_jpy
- status (`draft`, `confirmed`, `reconciled`)

### 5.7 経費・証憑

#### expense

- id
- workspace_id
- business_unit_id
- reporting_entity_id
- occurred_at
- counterparty_id nullable
- description
- amount_jpy
- payment_account_id
- accounting_account_id
- business_use_ratio
- status (`draft`, `confirmed`, `cancelled`)
- attachment_reference_id nullable
- memo

#### attachment_reference

- id
- workspace_id
- storage_type (`none`, `local_path`, `external_url`)
- path_or_url
- document_type
- transaction_date nullable
- amount_jpy nullable
- counterparty_name nullable
- note

MVPではファイル本体をアップロードしない。

### 5.8 棚卸

#### inventory_count

- id
- business_unit_id
- count_date
- storage_location_id nullable
- status (`draft`, `counting`, `review`, `finalized`)
- finalized_at nullable

#### inventory_count_line

- id
- inventory_count_id
- item_variant_id
- unique_stock_unit_id nullable
- expected_quantity
- actual_quantity
- difference_quantity
- difference_reason nullable
- adjustment_stock_movement_id nullable

### 5.9 会計

#### accounting_account

- id
- reporting_entity_id
- code
- name
- category (`asset`, `liability`, `equity`, `revenue`, `expense`)
- tax_form_mapping nullable
- active

#### journal_entry

- id
- reporting_entity_id
- fiscal_year_profile_id
- entry_date
- description
- source_type nullable
- source_id nullable
- source_event nullable
- idempotency_key nullable
- status (`draft`, `posted`, `reversed`)
- reversal_of_id nullable
- created_by_operator_id
- posted_at nullable

#### journal_line

- id
- journal_entry_id
- accounting_account_id
- debit_jpy
- credit_jpy
- business_unit_id nullable
- counterparty_id nullable
- memo nullable

仕訳ごとに借方合計と貸方合計が一致しなければ投稿できない。

#### opening_balance

- id
- fiscal_year_profile_id
- accounting_account_id
- debit_jpy
- credit_jpy
- source_note

#### accounting_rule

- id
- reporting_entity_id nullable
- event_type
- debit_account_id
- credit_account_id
- amount_source
- active

初期版では標準テンプレートを提供し、設定画面で勘定科目を差し替えられるようにする。

#### audit_log

- id
- workspace_id
- operator_id nullable
- action
- entity_type
- entity_id
- before_json nullable
- after_json nullable
- occurred_at
- request_id nullable

---

## 6. 在庫・原価計算ルール

### 6.1 数量在庫

- 同一商品を複数個保有する。
- 仕入ロットごとに実際原価を保持する。
- 販売価格は在庫ではなく出品に保持する。
- 一部だけ値下げしても在庫商品は分割しない。
- 傷、状態、原価が大きく異なる場合は別バリアントまたは個体へ分割できる。

### 6.2 個体在庫

- 古着は1着ごとに個体コードを付ける。
- 個体ごとに状態、採寸、原価、保管場所を保持する。
- 同じ個体を複数の販売完了注文へ割り当ててはならない。

### 6.3 セットSKU

- 初期方式は仮想セットのみ。
- セット作成時には在庫を減らさない。
- 注文確定時に構成品を引き当てる。
- 販売確定時に構成品を出庫する。
- キャンセル時には引当を解除する。
- 返品時には、構成品ごとに「良品戻し」「不良品」「廃棄」を選択する。

セットの販売可能数:

`min(各構成品の販売可能数量 ÷ 必要数量の切り捨て)`

個体指定構成品は、その個体が在庫中の場合のみ1セット販売可能。

### 6.4 引当と出庫

- 注文`confirmed`で引当移動を作成する。
- 注文`completed`で引当を販売出庫へ変換する。
- 運用設定により`shipped`で出庫する選択肢を将来追加可能にする。
- MVPの標準は`completed`で販売出庫。ただし画面上の販売可能在庫は引当分を除外する。

### 6.5 管理原価

- 個体在庫: 個別原価
- 数量在庫: 初期標準は移動平均法
- 売却時に使用した原価を`order_component_consumption`へ固定保存する。
- 仕入原価が暫定の場合は、販売利益も暫定と表示する。
- 仕入原価確定後に対象販売の管理原価を再計算し、変更履歴を残す。

### 6.6 年末の税務在庫評価

- 管理原価と税務上の棚卸評価方法は別設定とする。
- 既存の申告で採用している評価方法を移行時に確認し、年度プロファイルへ設定する。
- アプリが評価方法を勝手に変更しない。
- 少なくとも`個別法`、`最終仕入原価法`、`総平均法`に拡張できる構造とする。
- MVP会計フェーズでは、個別法と最終仕入原価法を実装対象とする。

---

## 7. 原価配賦ルール

### 7.1 対応方式

- 数量比
- 商品金額比
- 重量比
- 容積比
- 手入力
- 在庫原価に含めず当期経費

### 7.2 計算

各明細の未丸め配賦額をDecimalで計算し、円単位に丸める。丸め差額は以下の順で決定的に配分する。

1. 未丸め額の小数部分が最大の明細
2. 同値の場合は配賦基準値が最大の明細
3. さらに同値の場合は購入明細ID昇順

### 7.3 確定条件

- 各費用の配賦合計 = 費用の円換算額
- 商品代 + 在庫原価に含める配賦費用 = 最終仕入原価合計
- 良品到着数が0の商品へ在庫原価を配賦する場合は警告する
- 不足・不良・返金の処理が未確定なら原価を暫定表示する
- 原価確定後の変更は、再計算理由の入力を必須とする

---

## 8. 状態遷移

### 8.1 Rakumart仕入れ

```text
下書き → 発注済み → 支払済み → 一部入庫／入庫済み
      → 原価計算中 → 原価確定
      ↘ キャンセル
```

原価確定後も追加請求を登録できる。その場合は「再原価計算待ち」として既存利益を暫定へ戻す。

### 8.2 出品

```text
下書き → 出品中 → 一時停止 → 出品中
                  ↘ 終了
出品中 → 売切れ
```

### 8.3 注文

```text
下書き → 注文確定 → 発送待ち → 発送済み
      → 取引完了待ち → 取引完了

注文確定以前 → キャンセル
発送済み以後 → 返品処理
```

### 8.4 会計年度

```text
処理中 → 決算確認中 → ロック済み
```

- ロック済み年度の元取引は変更不可。
- 修正が必要な場合はロック解除理由を記録するか、翌年度に修正仕訳を作成する。
- ロック解除は管理操作とする。

---

## 9. 画面仕様

### 9.1 共通レイアウト

スマートフォン下部ナビゲーション:

1. ホーム
2. 登録
3. 商品・在庫
4. 販売
5. その他

画面上部:

- 現在の販売部門
- 対象年度または期間
- 通信状態
- 未保存状態

部門は色で識別する。部門変更後は、登録画面の既入力内容を勝手に引き継がない。

### 9.2 ホーム

表示:

- 今月売上
- 今月概算利益
- 販売件数
- 在庫数量・在庫金額
- 発送待ち
- 入金待ち
- 原価未確定
- マイナス在庫警告
- 長期滞留在庫

クイック操作:

- 仕入れ
- 販売
- 経費
- 商品検索

本人・妻合算表示は管理レポートだけに使用し、申告帳票では合算しない。

### 9.3 登録メニュー

- 中国輸入仕入れ
- 古着・個体仕入れ
- 国内数量仕入れ
- 販売
- 経費
- 入金
- 在庫調整

### 9.4 商品・在庫一覧

検索:

- 商品名
- SKUコード
- 個体コード
- 外部出品ID
- ブランド
- 保管場所

絞り込み:

- 部門
- 数量／個体
- 在庫あり／なし
- 出品中
- 原価未確定
- 長期滞留
- 状態

### 9.5 商品詳細

タブ:

- 基本情報
- 在庫・ロット
- 販売SKU
- 出品
- 販売履歴
- 原価履歴
- 在庫移動

### 9.6 販売画面

状態別タブ:

- 出品中
- 発送待ち
- 発送済み
- 取引完了待ち
- 入金待ち
- 完了
- キャンセル・返品

### 9.7 その他

- Rakumart案件
- 売上金・預け金
- 棚卸
- 利益レポート
- 帳簿・決算
- CSV入出力
- マスタ設定
- バックアップ状態
- 監査履歴

---

## 10. 操作フロー

### 10.1 中国輸入仕入れ

1. 部門「本人・中国輸入」を選択。
2. 「登録」→「中国輸入仕入れ」。
3. Rakumart注文番号、発注日、為替情報を入力。
4. 商品明細を追加。既存商品へ紐付けるか新規商品を作る。
5. Rakumartへの預け金入金・利用を登録。
6. 中国国内送料、代行手数料、国際送料、関税等を追加。
7. 到着時に良品、不良、不足数量を入力。
8. 費用の配賦方法を選択。
9. 配賦結果と1個原価を確認。
10. 「原価確定・入庫」で在庫移動と会計イベントを生成。

一部入庫を許可する。同じ発注明細から複数ロットを作成できる。

### 10.2 古着まとめ仕入れ

1. 部門「妻・アパレル」を選択。
2. 仕入日、仕入先、合計金額、点数を入力。
3. 個体を1着ずつ連続登録。
4. 各個体へ原価を手入力。
5. 画面上部に総額、配賦済み、未配賦を表示。
6. 合計一致後に入庫確定。

### 10.3 販売SKU作成

- 単品: 構成品を1件登録。
- セット: 複数構成品と必要数量を登録。
- 保存前にセット原価、販売可能数、想定利益を表示。
- 循環参照は禁止。初期版ではSKUを別SKUの構成品にはできず、在庫商品のみ指定可能。

### 10.4 メルカリ出品

1. 商品または販売SKUから「出品を登録」。
2. メルカリ、価格、数量、URL、出品IDを入力。
3. 手数料率、想定送料を初期値から確認。
4. 出品中へ変更。

値下げ時は出品価格履歴を追加し、過去値を上書きしない。

### 10.5 販売登録

最短操作:

1. ホームの「販売」。
2. 出品、SKU、個体コードのいずれかで検索。
3. 販売価格・販売日時を確認。
4. 「販売確定」。

自動処理:

- 注文を作成
- 構成在庫を引当
- 出品数量を更新
- 発送待ちへ追加
- 手数料・送料の暫定値を設定
- 概算利益を更新
- 会計イベント候補を作成

同じ外部注文IDの重複登録は禁止。外部注文IDがない場合も、確認画面で二重登録警告を表示する。

### 10.6 発送・取引完了

- 発送時: 発送日、方法、実送料、追跡番号を登録。
- 取引完了時: 完了日、確定手数料、確定売上金を登録。
- 取引完了で在庫引当を販売出庫へ変換し、管理原価を固定する。
- 送料等が未確定なら利益を暫定表示する。

### 10.7 キャンセル・返品

キャンセル:

- 在庫引当解除
- 出品を必要に応じて再開
- 売上・手数料の会計イベントを取消

返品:

- 注文全体または明細単位
- 構成品ごとに良品在庫、不良在庫、廃棄を選択
- 売上、手数料、送料の返還有無を別々に入力
- 元仕訳への反対仕訳を生成

### 10.8 経費

入力:

- 日付
- 支払先
- 内容
- 金額
- 支払方法
- 部門
- 勘定科目
- 事業使用割合
- 証憑参照

事業使用割合が100%未満なら、事業部分だけを経費仕訳へ反映する。端数処理を表示する。

### 10.9 販路売上金・銀行入金

1. 取引完了で販路売上金残高を増加。
2. 手数料・販路控除送料で残高を減少。
3. 振込登録で販路残高を減少し、銀行口座残高を増加。
4. 明細合計と実入金が一致すれば照合済み。
5. 差額があれば振込手数料、未登録取引、調整の候補を表示。

### 10.10 棚卸

1. 棚卸日と保管場所を指定。
2. 理論在庫を固定した棚卸スナップショットを作成。
3. 実数を入力。
4. 差異と金額を確認。
5. 差異理由を入力。
6. 確定すると在庫調整移動を作成。
7. 年末棚卸表へ反映。

---

## 11. 会計仕様

### 11.1 基本方針

- 本人: 青色申告、複式簿記、65万円控除に必要な帳簿作成を目標とする。
- 妻: 白色申告用の収支集計。内部的には同じ仕訳基盤を利用可能。
- アプリは所得税確定申告書の作成・送信を行わない。
- 仕訳帳、総勘定元帳、試算表、損益計算書、貸借対照表、棚卸表を作成する。
- 白色申告用に収支内訳書へ転記可能な集計を作成する。

### 11.2 仕訳生成タイミング

業務イベントごとに仕訳を生成する。仕訳生成には一意な`idempotency_key`を使用する。

標準イベント:

- `agent_deposit_funded`
- `purchase_recognized`
- `purchase_charge_expensed`
- `sale_recognized`
- `channel_fee_recognized`
- `shipping_paid_from_channel`
- `shipping_paid_other`
- `channel_payout_received`
- `expense_confirmed`
- `sale_cancelled`
- `sale_returned`
- `inventory_year_end_adjusted`

### 11.3 標準仕訳テンプレート

勘定科目名は初期値。既存のマネーフォワード科目に合わせて変更できる。

#### Rakumartへ預け金を入金

```text
借方: 預け金         実支払円額
貸方: 普通預金等     実支払円額
```

#### 商品仕入れを認識

```text
借方: 仕入高         認識する仕入円額
貸方: 預け金／未払金 認識する仕入円額
```

認識日はユーザーが確認する。単なる発注日を自動的に会計認識日にしない。

#### 販売成立

```text
借方: メルカリ売上金等  総売上額
貸方: 売上高            総売上額
```

標準の売上認識日は取引完了日。設定で発送日等へ変更可能にするが、年度中は継続適用を促す。

#### 販売手数料

```text
借方: 支払手数料        手数料
貸方: メルカリ売上金等  手数料
```

#### 販路残高から控除された送料

```text
借方: 荷造運賃          送料
貸方: メルカリ売上金等  送料
```

#### 売上金の銀行入金

```text
借方: 普通預金          純入金額
借方: 支払手数料        振込手数料
貸方: メルカリ売上金等  振込総額
```

#### 現金・カードによる経費

```text
借方: 該当経費          事業使用額
貸方: 現金／未払金等    事業使用額
```

個人資金で支払った場合は、相手科目を事業主借とする設定を用意する。

### 11.4 売上原価と棚卸

日常の管理利益では販売時に管理原価を差し引く。税務帳簿では仕入高と年末棚卸から売上原価を計算する。

決算整理の具体的な勘定科目・仕訳形式は、既存のマネーフォワード帳簿と採用中の棚卸評価方法を確認後に確定する。実装時は次を満たすこと。

- 期首棚卸高
- 当期仕入高
- 期末棚卸高
- 売上原価
- 棚卸表との一致
- 翌年度への期末在庫繰越

### 11.5 仕訳の編集

- 自動仕訳は生成直後`draft`。
- 月次確認または自動投稿設定で`posted`。
- 投稿済み仕訳の金額・科目は直接更新不可。
- 取消時は反対仕訳を作成。
- 元取引、元仕訳、反対仕訳を相互リンクする。

### 11.6 年度ロック

ロック前チェック:

- 借方貸方不一致がない
- 下書き仕訳がない
- 原価未確定仕入れがない、または明示的に承認済み
- マイナス在庫がない
- 棚卸確定済み
- 販路残高・預金・預け金の照合状況を表示

---

## 12. レポート・帳票

### 12.1 管理レポート

- 日別・月別・年別売上
- 概算利益・確定利益
- 商品別利益
- SKU別利益
- 販路別利益
- 部門別利益
- 本人・妻合算の家庭内管理レポート
- 在庫数量・在庫金額
- 在庫回転期間
- 長期滞留在庫
- 赤字販売
- 原価未確定販売
- Rakumart案件別原価

### 12.2 会計帳票

- 仕訳帳
- 総勘定元帳
- 現金出納帳
- 預金出納帳
- 売掛・販路残高帳
- 買掛・未払帳
- 経費帳
- 固定資産台帳（会計フェーズ後半）
- 試算表
- 損益計算書
- 貸借対照表
- 棚卸表
- 青色申告決算書への転記集計
- 白色申告収支内訳書への転記集計

### 12.3 ドリルダウン

すべての集計値は、以下の順に元データへ移動できるようにする。

```text
レポート集計
→ 明細一覧
→ 元取引
→ 在庫移動／販路残高移動
→ 自動仕訳
```

---

## 13. CSV入出力・移行

### 13.1 マネーフォワード移行

対応順:

1. 勘定科目マッピング
2. 開始残高
3. 期首在庫
4. 当年仕訳
5. 固定資産

CSV取込は必ず以下の工程を持つ。

```text
ファイル選択
→ 文字コード・列解析
→ 項目マッピング
→ プレビュー
→ エラー修正
→ 取込確定
→ 取込結果レポート
```

同じファイルを再取込しても重複しないよう、行ハッシュと取込バッチIDを保存する。

### 13.2 開始残高

- 現金
- 銀行
- クレジットカード未払
- メルカリ売上金
- Rakumart預け金
- 売掛金
- 買掛金・未払金
- 期首在庫
- 固定資産・減価償却累計額
- 元入金・事業主勘定

開始残高は貸借一致を確認してから確定する。

### 13.3 エクスポート

- 商品マスターCSV
- 在庫一覧CSV
- 在庫移動CSV
- 仕入CSV
- 販売CSV
- 経費CSV
- 仕訳CSV
- 棚卸表CSV
- 全データJSONバックアップ

CSVはUTF-8 BOM付きとBOMなしを選択可能にする。

---

## 14. セキュリティ・バックアップ・運用

### 14.1 セキュリティ

- インターネットへデータベースポートを公開しない。
- アプリをCloudflare Access等の認証の内側に置く。
- CSRF、XSS、SQLインジェクション対策を行う。
- 秘密情報は環境変数で管理し、リポジトリへ含めない。
- 外部URLは表示時に安全なスキームのみ許可する。
- 監査ログにパスワード、Cookie、秘密鍵を記録しない。

### 14.2 バックアップ

- PostgreSQLの日次バックアップ
- 直近14日分を保持
- 月次バックアップを12か月保持
- バックアップを自宅PCとは別の保存先へ複製
- バックアップファイルを暗号化
- 月1回、復元テストを行える手順を用意
- バックアップ成功・失敗をアプリの設定画面へ表示

### 14.3 障害時

- データベース停止時に書き込みを受け付けない。
- 途中まで成功する複合処理を避け、販売確定・在庫移動・会計イベントを同一DBトランザクションにする。
- エラー時に利用者へ再実行可否を明示する。
- リクエストIDをログへ記録する。

### 14.4 更新

- DBマイグレーション前に自動バックアップする。
- 更新失敗時の戻し方をREADMEへ記載する。
- 開発、テスト、本番の環境変数を分ける。

---

## 15. 非機能要件

### 15.1 対応画面

- iPhone/Androidの一般的なスマートフォン幅
- タブレット
- Windows PCのChrome/Edge
- タップ領域は原則44px以上
- 日本語UI
- 金額は3桁区切り
- 日付入力は日本時間

### 15.2 性能

家庭内の数万件規模を想定する。

- 通常一覧: 2秒以内を目標
- 販売確定: 2秒以内を目標
- 検索結果: 1秒以内を目標
- 大量CSV: バックグラウンド処理と進捗表示

### 15.3 アクセシビリティ

- 色だけで状態を表現しない。
- フォームラベルを省略しない。
- キーボード操作可能。
- エラー箇所と修正方法を日本語で表示。

### 15.4 監査性

- 誰が、いつ、何を変更したかを追跡可能。
- 自動計算値の根拠を表示する。
- CSV取込元と取込日時を記録する。
- 申告主体を変更した履歴を保持する。

---

## 16. 実装フェーズ

### フェーズ0: 基盤

- リポジトリ初期化
- Docker Compose
- PostgreSQL
- ORM・マイグレーション
- 認証
- ワークスペース、利用者、申告主体、部門、年度設定
- PWA基本設定
- CI、静的解析、テスト基盤
- バックアップスクリプトと復元手順の雛形

完了条件:

- PCとスマホ幅でログインできる。
- 本人・妻の入力者、部門を切り替えられる。
- DBを初期化・マイグレーションできる。

### フェーズ1: 商品・仕入れ・在庫

- 数量商品
- 個体商品
- 国内仕入れ
- 古着まとめ仕入れ
- 在庫移動
- 保管場所
- 商品検索

完了条件:

- 50個仕入れると在庫が50個になる。
- 古着10着を別個体で登録できる。
- 古着原価配賦合計が仕入総額と一致しない場合は確定できない。

### フェーズ2: SKU・出品・販売

- 単品SKU
- セットSKU
- メルカリ出品
- 値下げ履歴
- 注文
- 在庫引当
- 発送・完了
- キャンセル・返品
- 概算利益

完了条件:

- セット販売で全構成品が正しい数量だけ減る。
- 同一注文の再送信で在庫が二重に減らない。
- 同じ数量在庫を異なる価格で出品できる。

### フェーズ3: Rakumart

- 預け金
- 外貨・為替
- 発注明細
- 一部入庫
- 各種付随費用
- 原価配賦
- 不足・不良・返金

完了条件:

- 配賦合計が支払総額と一致する。
- 商品ごとの円建て1個原価を追跡できる。
- 預け金残高の増減根拠を表示できる。

### フェーズ4: 経費・販路残高・管理レポート

- 経費
- 家事按分
- メルカリ売上金
- 銀行入金照合
- 商品・SKU・部門・販路別利益
- 赤字、原価未確定警告

### フェーズ5: 複式簿記

- 勘定科目
- 自動仕訳
- 仕訳投稿・反対仕訳
- 元帳
- 試算表
- 損益計算書
- 貸借対照表
- 年度ロック

フェーズ開始前に、ユーザーの現在のマネーフォワード勘定科目と仕訳例を確認する。

### フェーズ6: 棚卸・申告用集計・移行

- 棚卸
- 税務在庫評価
- 決算整理
- 青色申告決算書転記集計
- 白色申告収支内訳書転記集計
- マネーフォワード仕訳・開始残高取込
- 帳票CSV/PDF

### フェーズ7: 外部連携

- メルカリShops CSV/API
- ラクマ等のCSV
- 銀行・カード明細CSV
- Amazon、Yahoo!ショッピング拡張

個人向けメルカリの非公式自動取得は行わない。

---

## 17. 主要受け入れテスト

### AC-01 部門と申告主体

前提:

- 2026年の中国輸入は本人へ割当
- 2026年のアパレルは妻へ割当

期待結果:

- 中国輸入売上は本人帳簿だけに含まれる。
- アパレル売上は妻集計だけに含まれる。
- 家庭内合算レポートでは両方を表示できる。
- 同一取引が両方へ重複しない。

### AC-02 年度別割当変更

- 2027年のアパレルを本人へ割り当てる。
- 2026年データは妻のまま変わらない。
- 2027年データは本人の帳簿へ含まれる。
- 変更履歴が残る。

### AC-03 数量商品の値下げ販売

- 同一商品の在庫を50個登録する。
- 1,280円と980円の2出品を作成する。
- 980円の出品を1個販売する。

期待結果:

- 共通在庫が49個になる。
- 1,280円出品の価格は変わらない。
- 売上と利益は980円を基準に計算される。

### AC-04 セットSKU

在庫:

- ケース10個
- フィルム15枚
- クリーナー100枚

セット構成:

- ケース1個
- フィルム2枚
- クリーナー1枚

期待結果:

- 販売可能数は7セット。
- 1セット完了後はケース9、フィルム13、クリーナー99。
- 同じ完了処理を再実行しても追加で減らない。

### AC-05 古着まとめ仕入れ

- 総額20,000円、10着で仕入れる。
- 9着までの原価割当合計が18,000円。

期待結果:

- 未配賦2,000円と表示する。
- 仕入を確定できない。
- 10着の合計を20,000円にすると確定できる。

### AC-06 Rakumart配賦

- 複数商品、国際送料、代行手数料を登録。
- 重量比と商品金額比を混在させる。

期待結果:

- 各費用の配賦合計が元費用と1円単位で一致する。
- 丸め差額の割当先が再計算しても同じ。
- 入庫ロットの合計原価と配賦結果が一致する。

### AC-07 販売キャンセル

- セット注文を確定して在庫引当する。
- 発送前にキャンセルする。

期待結果:

- 引当が全て解除される。
- 在庫は販売前と同じ販売可能数に戻る。
- 売上は計上されない。

### AC-08 販路入金

- 総売上10,000円、手数料1,000円、送料750円。
- 販路残高8,250円。
- 8,050円が銀行入金、振込手数料200円。

期待結果:

- 販路残高が0円になる。
- 銀行が8,050円増える。
- 振込手数料200円が記録される。
- 仕訳の借方・貸方が一致する。

### AC-09 年度ロック

- 年度をロックする。
- ロック済み年度の販売を直接変更しようとする。

期待結果:

- 変更を拒否する。
- ロック解除または翌年度修正の案内を表示する。

### AC-10 バックアップ復元

- 商品、在庫、販売、仕訳を含むバックアップを取得。
- 空の検証環境へ復元。

期待結果:

- 件数と主要残高が一致する。
- ログイン後に取引履歴を参照できる。

---

## 18. 初期マスター

### 18.1 販路

- メルカリ
- ラクマ
- Yahoo!フリマ
- メルカリShops
- その他

### 18.2 部門

- 本人・中国輸入
- 妻・アパレル

### 18.3 申告主体

- 本人
- 妻

### 18.4 在庫差異理由

- 入力漏れ
- 紛失
- 破損
- 廃棄
- 私用
- 数え間違い
- その他

### 18.5 経費候補

- 荷造運賃
- 支払手数料
- 消耗品費
- 通信費
- 旅費交通費
- 外注工賃
- 地代家賃
- 水道光熱費
- 雑費

勘定科目は既存のマネーフォワード科目を確認してから確定する。

---

## 19. 実装開始前にユーザーから取得するデータ

機能開発は開始できるが、会計フェーズまでに以下を取得する。

- マネーフォワードの勘定科目一覧
- 代表的な仕訳例（個人情報を除いたもの）
- 期首残高
- 現在採用中の棚卸資産評価方法
- メルカリ取引の代表例
- Rakumart明細の代表例
- 返金・不足・関税を含む複雑な輸入例
- 夫婦それぞれの申告対象部門と適用開始年度

---

## 20. 税務・制度上の注意

- 青色申告の65万円控除は、帳簿作成だけでなく期限内申告やe-Tax等の要件確認が必要である。
- 妻のアパレル所得を本人へ含めるかは、実際の事業主・経営実態に基づいて判断する。
- 棚卸資産の評価方法は既存の届出・継続適用状況を確認する。
- 電子的に受領した請求書・領収書をアプリ外に置く場合も、利用者が適切な保存を行う。
- このアプリの計算結果だけを無検証で申告しない。少なくとも初年度は既存帳簿または専門家による照合を行う。

参考:

- 国税庁 青色申告制度: https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2070.htm
- 国税庁 記帳・帳簿保存: https://www.nta.go.jp/publication/pamph/koho/kurashi/html/01_2.htm
- 国税庁 実質所得者課税の原則: https://www.nta.go.jp/law/tsutatsu/kihon/shotoku/03/01.htm
- 国税庁 棚卸資産の評価方法: https://www.nta.go.jp/law/tsutatsu/kihon/shotoku/08/02.htm

---

## 21. Codexへの実装指示

Codexは以下を守ること。

1. まず既存リポジトリ、`AGENTS.md`、README、設定ファイルを確認する。
2. フェーズ0から順番に実装し、複数フェーズを無断でまとめない。
3. 実装前に対象フェーズの短い計画と変更対象を提示する。
4. 金額、在庫、仕訳の処理はDBトランザクション内で行う。
5. APIの更新操作には二重送信対策を入れる。
6. 確定データを物理削除しない。
7. 画面だけを作って処理をダミーのまま完了扱いにしない。
8. 正常系だけでなく、取消、返品、二重送信、原価未確定、年度ロックをテストする。
9. 実行したテストと未確認事項を各フェーズの最後に報告する。
10. 税務ルールを推測で追加しない。不明点は設定可能にするか、ユーザー確認事項として残す。

最初の依頼例:

```text
添付の「物販・在庫・会計管理アプリ 実装仕様書」を基準に開発してください。
今回はフェーズ0だけを実装してください。

最初に作業環境と既存ファイルを確認し、実装計画、採用する安定版ライブラリ、
作成予定のデータモデルを提示してください。その後、基盤、認証、初期設定画面、
Docker Compose、テスト、READMEまで実装してください。

仕様と異なる判断が必要な場合は、勝手に範囲を拡張せず、仮定を明示してください。
```

---

## 22. 完成の定義

アプリ全体を完成とするには、以下をすべて満たす必要がある。

- フェーズ0〜6の受け入れ条件を満たす。
- 自宅PCと外出先スマホから利用できる。
- バックアップ・復元テストに成功する。
- マネーフォワードとの開始残高・主要帳票照合が一致する。
- 数量在庫、個体在庫、セットSKU、返品を実データ相当で検証する。
- 本人の青色申告用集計と妻の白色申告用集計を分離できる。
- 年度ロック後の改変を防止できる。
- 既知の重大・高優先度不具合が残っていない。

外部販路API連携であるフェーズ7は、アプリ本体の完成条件には含めない。
