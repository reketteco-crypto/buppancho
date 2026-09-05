"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { saveUnifiedPurchaseAction, type InventoryActionState } from "@/app/inventory/actions";
import { createClientUuid } from "@/lib/client-uuid";

type Option = { id: string; label: string };
type Condition = "UNSPECIFIED" | "NEW" | "USED";
type Tracking = "QUANTITY" | "UNIQUE";
type VariantSelection =
  | { source: "EXISTING"; variantId: string }
  | { source: "NEW"; productRef: string; variantRef: string };
type Line = {
  clientRef: string;
  variant: VariantSelection;
  trackingMode: Tracking;
  conditionCategory: Condition;
  conditionDescription: string;
  sourceName: string;
  sourceUrl: string;
  quantity: number;
  amountJpy: string;
  individualCode?: string;
  measurements?: Record<string, string>;
  measurementsText?: string;
  commonMeasurements?: Record<string, string>;
  commonMeasurementsText?: string;
  memo?: string;
};
type ProductDraft = {
  clientRef: string;
  itemCode: string;
  name: string;
  category: string;
  defaultConditionCategory: Condition;
  defaultTrackingMode: Tracking;
  memo: string;
  variants: Array<{
    clientRef: string;
    variantCode: string;
    attributes: Record<string, string>;
  }>;
};
type Axis = { id: string; name: string; values: string };

const uuid = () => createClientUuid();
const parseMap = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((row) => row.split(":", 2).map((value) => value.trim()))
      .filter((pair): pair is [string, string] => Boolean(pair[0] && pair[1]))
      .slice(0, 20),
  );
const generatedCode = () => `VAR-${uuid().replaceAll("-", "").slice(0, 8).toUpperCase()}`;

function cartesian(axes: Axis[]): Array<Record<string, string>> {
  const usable = axes
    .map((axis) => ({
      name: axis.name.trim(),
      values: axis.values
        .split(/[、,\n]/)
        .map((value) => value.trim())
        .filter(Boolean),
    }))
    .filter((axis) => axis.name && axis.values.length);
  if (!usable.length) return [{}];
  return usable.reduce<Array<Record<string, string>>>(
    (rows, axis) =>
      rows.flatMap((row) => axis.values.map((value) => ({ ...row, [axis.name]: value }))),
    [{}],
  );
}

export function PurchaseForm(props: {
  suppliers: Option[];
  locations: Option[];
  variants: Option[];
  today: string;
  initial?: {
    purchaseId: string;
    requestKey: string;
    purchasedDate: string;
    supplierId: string;
    storageLocationId: string;
    orderNumber: string;
    purchaseTotalJpy: string;
    memo: string;
    lines: Line[];
  };
}) {
  const [state, action, pending] = useActionState(
    saveUnifiedPurchaseAction,
    {} as InventoryActionState,
  );
  const [date, setDate] = useState(props.initial?.purchasedDate ?? props.today);
  const [supplierId, setSupplierId] = useState(
    props.initial?.supplierId ?? props.suppliers[0]?.id ?? "",
  );
  const [locationId, setLocationId] = useState(
    props.initial?.storageLocationId ?? props.locations[0]?.id ?? "",
  );
  const [orderNumber, setOrderNumber] = useState(props.initial?.orderNumber ?? "");
  const [total, setTotal] = useState(props.initial?.purchaseTotalJpy ?? "");
  const [memo, setMemo] = useState(props.initial?.memo ?? "");
  const [requestKey] = useState(() => props.initial?.requestKey ?? uuid());
  const [products, setProducts] = useState<ProductDraft[]>([]);
  const [showProduct, setShowProduct] = useState(false);
  const [product, setProduct] = useState<Omit<ProductDraft, "variants">>({
    clientRef: uuid(),
    itemCode: "",
    name: "",
    category: "",
    defaultConditionCategory: "UNSPECIFIED",
    defaultTrackingMode: "QUANTITY",
    memo: "",
  });
  const [axes, setAxes] = useState<Axis[]>([
    { id: uuid(), name: "色", values: "" },
    { id: uuid(), name: "サイズ", values: "" },
  ]);
  const [generated, setGenerated] = useState<ProductDraft["variants"]>([]);

  const allVariants = useMemo(
    () => [
      ...props.variants.map((variant) => ({
        key: `existing:${variant.id}`,
        label: variant.label,
        value: { source: "EXISTING", variantId: variant.id } as VariantSelection,
      })),
      ...products.flatMap((item) =>
        item.variants.map((variant) => ({
          key: `new:${item.clientRef}:${variant.clientRef}`,
          label: `新規: ${item.name} / ${Object.values(variant.attributes).join("・") || "標準"}`,
          value: {
            source: "NEW",
            productRef: item.clientRef,
            variantRef: variant.clientRef,
          } as VariantSelection,
        })),
      ),
    ],
    [products, props.variants],
  );
  const emptyLine = (profile: "new" | "used"): Line => ({
    clientRef: uuid(),
    variant: allVariants[0]?.value ?? { source: "EXISTING", variantId: "" },
    trackingMode: profile === "new" ? "QUANTITY" : "UNIQUE",
    conditionCategory: profile === "new" ? "NEW" : "USED",
    conditionDescription: profile === "new" ? "新品" : "",
    sourceName: "",
    sourceUrl: "",
    quantity: 1,
    amountJpy: "",
    individualCode: "",
    measurements: {},
    measurementsText: "",
    commonMeasurements: {},
    commonMeasurementsText: "",
    memo: "",
  });
  const [lines, setLines] = useState<Line[]>(props.initial?.lines ?? []);
  const allocated = useMemo(
    () =>
      lines.reduce(
        (sum, line) => sum + BigInt(/^\d+$/.test(line.amountJpy) ? line.amountJpy : "0"),
        0n,
      ),
    [lines],
  );
  const target = BigInt(/^\d+$/.test(total) ? total : "0");
  const update = (index: number, change: Partial<Line>) =>
    setLines((current) =>
      current.map((line, row) => (row === index ? { ...line, ...change } : line)),
    );
  const selectKey = (selection: VariantSelection) =>
    selection.source === "EXISTING"
      ? `existing:${selection.variantId}`
      : `new:${selection.productRef}:${selection.variantRef}`;
  const payload = {
    ...(props.initial ? { purchaseId: props.initial.purchaseId } : {}),
    purchasedDate: date,
    supplierId,
    storageLocationId: locationId,
    orderNumber,
    purchaseTotalJpy: total,
    memo,
    idempotencyKey: requestKey,
    newProducts: products,
    lines: lines.map((line) =>
      line.trackingMode === "QUANTITY"
        ? {
            clientRef: line.clientRef,
            variant: line.variant,
            trackingMode: "QUANTITY" as const,
            conditionCategory: line.conditionCategory,
            conditionDescription: line.conditionDescription,
            sourceName: line.sourceName,
            sourceUrl: line.sourceUrl,
            quantity: line.quantity,
            amountJpy: line.amountJpy,
            commonMeasurements: line.commonMeasurements ?? {},
          }
        : {
            clientRef: line.clientRef,
            variant: line.variant,
            trackingMode: "UNIQUE" as const,
            conditionCategory: line.conditionCategory,
            conditionDescription: line.conditionDescription,
            sourceName: line.sourceName,
            sourceUrl: line.sourceUrl,
            quantity: 1 as const,
            amountJpy: line.amountJpy,
            individualCode: line.individualCode ?? "",
            measurements: line.measurements ?? {},
            memo: line.memo ?? "",
          },
    ),
  };
  const ready = props.suppliers.length > 0 && props.locations.length > 0 && lines.length > 0;

  return (
    <form action={action} className="stack">
      {state.error ? (
        <p className="message error" role="alert">
          {state.error}
        </p>
      ) : null}
      {!props.suppliers.length || !props.locations.length ? (
        <p className="notice">
          登録には<Link href="/settings/suppliers">仕入先</Link>と
          <Link href="/settings/storage-locations">保管場所</Link>が必要です。
        </p>
      ) : null}
      <section className="card summary-strip" aria-label="仕入れ配賦状況">
        <div>
          <span>仕入総額</span>
          <strong>¥{target.toLocaleString("ja-JP")}</strong>
        </div>
        <div>
          <span>明細合計</span>
          <strong>¥{allocated.toLocaleString("ja-JP")}</strong>
        </div>
        <div>
          <span>未配賦</span>
          <strong className={target === allocated ? "ok-text" : "danger-text"}>
            ¥{(target - allocated).toLocaleString("ja-JP")}
          </strong>
        </div>
        <div>
          <span>登録点数</span>
          <strong>{lines.length}件</strong>
        </div>
      </section>

      <div className="form-grid">
        <label className="field">
          <span>仕入日</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>仕入先</span>
          <select
            value={supplierId}
            onChange={(event) => setSupplierId(event.target.value)}
            required
          >
            <option value="">選択してください</option>
            {props.suppliers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>保管場所</span>
          <select
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            required
          >
            <option value="">選択してください</option>
            {props.locations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>仕入総額（円）</span>
          <input
            inputMode="numeric"
            pattern="[0-9]+"
            value={total}
            onChange={(event) => setTotal(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>注文番号（任意）</span>
          <input
            value={orderNumber}
            onChange={(event) => setOrderNumber(event.target.value)}
            maxLength={100}
          />
        </label>
      </div>

      <section className="card stack">
        <div className="section-heading">
          <div>
            <h2>商品</h2>
            <p className="muted">既存商品を選ぶか、この仕入れの中で新しく作成できます。</p>
          </div>
          <button
            type="button"
            className="button secondary"
            onClick={() => setShowProduct((value) => !value)}
          >
            新しい商品を作成
          </button>
        </div>
        {showProduct ? (
          <div className="stack">
            <div className="form-grid">
              <label className="field">
                <span>商品名</span>
                <input
                  value={product.name}
                  onChange={(event) => setProduct({ ...product, name: event.target.value })}
                />
              </label>
              <label className="field">
                <span>商品コード</span>
                <input
                  value={product.itemCode}
                  onChange={(event) =>
                    setProduct({ ...product, itemCode: event.target.value.toUpperCase() })
                  }
                  placeholder="空欄なら自動採番"
                />
              </label>
              <label className="field">
                <span>既定の商品区分</span>
                <select
                  value={product.defaultConditionCategory}
                  onChange={(event) =>
                    setProduct({
                      ...product,
                      defaultConditionCategory: event.target.value as Condition,
                    })
                  }
                >
                  <option value="UNSPECIFIED">未指定</option>
                  <option value="NEW">新品</option>
                  <option value="USED">中古</option>
                </select>
              </label>
              <label className="field">
                <span>既定の追跡方式</span>
                <select
                  value={product.defaultTrackingMode}
                  onChange={(event) =>
                    setProduct({ ...product, defaultTrackingMode: event.target.value as Tracking })
                  }
                >
                  <option value="QUANTITY">数量管理</option>
                  <option value="UNIQUE">個体管理</option>
                </select>
              </label>
              <label className="field">
                <span>カテゴリ</span>
                <input
                  value={product.category}
                  onChange={(event) => setProduct({ ...product, category: event.target.value })}
                />
              </label>
            </div>
            <h3>バリアント属性</h3>
            {axes.map((axis, index) => (
              <div className="form-grid" key={axis.id}>
                <label className="field">
                  <span>属性名</span>
                  <input
                    value={axis.name}
                    onChange={(event) =>
                      setAxes((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, name: event.target.value } : row,
                        ),
                      )
                    }
                    placeholder="色"
                  />
                </label>
                <label className="field">
                  <span>値（カンマ区切り）</span>
                  <input
                    value={axis.values}
                    onChange={(event) =>
                      setAxes((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, values: event.target.value } : row,
                        ),
                      )
                    }
                    placeholder="黒, 白"
                  />
                </label>
              </div>
            ))}
            <div className="actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setAxes((rows) => [...rows, { id: uuid(), name: "", values: "" }])}
              >
                属性を追加
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  setGenerated(
                    cartesian(axes).map((attributes) => ({
                      clientRef: uuid(),
                      variantCode: generatedCode(),
                      attributes,
                    })),
                  )
                }
              >
                組合せを生成
              </button>
            </div>
            {generated.map((variant, index) => (
              <div className="form-grid" key={variant.clientRef}>
                <div className="field">
                  <span>属性</span>
                  <strong>
                    {Object.entries(variant.attributes)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(" / ") || "標準"}
                  </strong>
                </div>
                <label className="field">
                  <span>バリアントコード</span>
                  <input
                    value={variant.variantCode}
                    onChange={(event) =>
                      setGenerated((rows) =>
                        rows.map((row, i) =>
                          i === index
                            ? { ...row, variantCode: event.target.value.toUpperCase() }
                            : row,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() => setGenerated((rows) => rows.filter((_, i) => i !== index))}
                >
                  除外
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button"
              disabled={!product.name || !generated.length}
              onClick={() => {
                setProducts((rows) => [...rows, { ...product, variants: generated }]);
                setShowProduct(false);
                setGenerated([]);
                setProduct({
                  clientRef: uuid(),
                  itemCode: "",
                  name: "",
                  category: "",
                  defaultConditionCategory: "UNSPECIFIED",
                  defaultTrackingMode: "QUANTITY",
                  memo: "",
                });
              }}
            >
              商品候補へ追加
            </button>
          </div>
        ) : null}
        {products.map((item) => (
          <p key={item.clientRef}>
            <strong>新規: {item.name}</strong>（{item.variants.length}バリアント）
          </p>
        ))}
      </section>

      <section className="stack">
        <div className="section-heading">
          <div>
            <h2>仕入明細</h2>
            <p className="muted">開始方法は初期値です。各明細の詳細設定で自由に変更できます。</p>
          </div>
          <div className="actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setLines((rows) => [...rows, emptyLine("new")])}
            >
              新品・同一商品
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setLines((rows) => [...rows, emptyLine("used")])}
            >
              中古・一点物
            </button>
          </div>
        </div>
        {!lines.length ? (
          <p className="notice">
            「新品・同一商品」または「中古・一点物」から明細を追加してください。
          </p>
        ) : null}
        {lines.map((line, index) => (
          <article className="card purchase-line" key={line.clientRef}>
            <div className="line-heading">
              <strong>明細 {index + 1}</strong>
              <button
                type="button"
                className="text-button danger-text"
                onClick={() => setLines((rows) => rows.filter((_, row) => row !== index))}
              >
                削除
              </button>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>商品・バリアント</span>
                <select
                  value={selectKey(line.variant)}
                  onChange={(event) => {
                    const found = allVariants.find((item) => item.key === event.target.value);
                    if (found) update(index, { variant: found.value });
                  }}
                  required
                >
                  <option value="">選択してください</option>
                  {allVariants.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>仕入時の商品名</span>
                <input
                  value={line.sourceName}
                  onChange={(event) => update(index, { sourceName: event.target.value })}
                  required
                />
              </label>
              <label className="field">
                <span>商品区分</span>
                <select
                  value={line.conditionCategory}
                  onChange={(event) =>
                    update(index, { conditionCategory: event.target.value as Condition })
                  }
                >
                  <option value="UNSPECIFIED">未指定</option>
                  <option value="NEW">新品</option>
                  <option value="USED">中古</option>
                </select>
              </label>
              <label className="field">
                <span>在庫追跡方式（詳細設定）</span>
                <select
                  value={line.trackingMode}
                  onChange={(event) =>
                    update(index, { trackingMode: event.target.value as Tracking, quantity: 1 })
                  }
                >
                  <option value="QUANTITY">数量管理</option>
                  <option value="UNIQUE">個体管理</option>
                </select>
              </label>
              {line.trackingMode === "QUANTITY" ? (
                <label className="field">
                  <span>数量</span>
                  <input
                    type="number"
                    min={1}
                    value={line.quantity}
                    onChange={(event) => update(index, { quantity: Number(event.target.value) })}
                    required
                  />
                </label>
              ) : (
                <label className="field">
                  <span>個体コード</span>
                  <input
                    value={line.individualCode}
                    onChange={(event) =>
                      update(index, { individualCode: event.target.value.toUpperCase() })
                    }
                    placeholder="空欄なら確定時に自動採番"
                  />
                </label>
              )}
              <label className="field">
                <span>{line.trackingMode === "QUANTITY" ? "明細原価総額" : "個別原価"}（円）</span>
                <input
                  inputMode="numeric"
                  pattern="[0-9]+"
                  value={line.amountJpy}
                  onChange={(event) => update(index, { amountJpy: event.target.value })}
                  required
                />
              </label>
              <label className="field">
                <span>状態</span>
                <input
                  value={line.conditionDescription}
                  onChange={(event) => update(index, { conditionDescription: event.target.value })}
                  required={line.trackingMode === "UNIQUE"}
                  placeholder={line.conditionCategory === "NEW" ? "新品" : "傷・汚れなど"}
                />
              </label>
              <label className="field">
                <span>参照URL（任意）</span>
                <input
                  type="url"
                  value={line.sourceUrl}
                  onChange={(event) => update(index, { sourceUrl: event.target.value })}
                />
              </label>
            </div>
            <label className="field">
              <span>
                {line.trackingMode === "QUANTITY" ? "共通属性・不足情報" : "個体固有の採寸"}（1行に
                項目: 値）
              </span>
              <textarea
                value={
                  line.trackingMode === "QUANTITY"
                    ? line.commonMeasurementsText
                    : line.measurementsText
                }
                onChange={(event) =>
                  line.trackingMode === "QUANTITY"
                    ? update(index, {
                        commonMeasurementsText: event.target.value,
                        commonMeasurements: parseMap(event.target.value),
                      })
                    : update(index, {
                        measurementsText: event.target.value,
                        measurements: parseMap(event.target.value),
                      })
                }
                placeholder={"肩幅: 40cm\n着丈: 65cm"}
              />
            </label>
          </article>
        ))}
      </section>
      <label className="field">
        <span>メモ</span>
        <textarea value={memo} onChange={(event) => setMemo(event.target.value)} maxLength={1000} />
      </label>
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <button className="button" disabled={pending || !ready || target !== allocated}>
        {pending ? "下書き保存中…" : "下書きを保存して確認へ"}
      </button>
    </form>
  );
}
