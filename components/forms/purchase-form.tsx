"use client";

import { SavedSettingsLink } from "@/components/forms/saved-settings-link";
import { useEffect, useMemo, useState } from "react";
import {
  PurchaseConflictPanel,
  PurchaseComparison,
  usePurchaseReview,
} from "@/components/forms/purchase-conflict-panel";
import { purchaseFieldNames, type PurchaseBaseline } from "@/lib/inventory/purchase-comparison";
import type { PurchaseReview } from "@/lib/inventory/purchase-conflict";
import { HydratedForm } from "@/components/forms/hydrated-form";
import { createClientUuid } from "@/lib/client-uuid";
import { MeasurementFields } from "@/components/forms/measurement-fields";
import {
  useWorkflowDraft,
  useSubmit,
  type InputContext,
  type DraftInitial,
} from "@/components/forms/workflow-forms";

type Option = { id: string; label: string; sourceName?: string };
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
export type PurchaseUiSnapshot = {
  purchaseId?: string;
  revision?: number;
  updatedAt?: string;
  date: string;
  supplierId: string;
  locationId: string;
  orderNumber: string;
  total: string;
  memo: string;
  requestKey: string;
  products: ProductDraft[];
  lines: Line[];
  step: number;
  builder?: {
    show: boolean;
    product: Omit<ProductDraft, "variants">;
    axes: Axis[];
    generated: ProductDraft["variants"];
  };
  replacedFields?: string[];
  baseSnapshot?: PurchaseBaseline | null;
};

const uuid = () => createClientUuid();
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
  context?: InputContext;
  draft?: DraftInitial;
  restored?: PurchaseUiSnapshot;
  baseline?: PurchaseBaseline | null;
  review?: PurchaseReview;
  forceReview?: boolean;
  suppliers: Option[];
  locations: Option[];
  variants: Option[];
  today: string;
  initial?: {
    purchaseId: string;
    revision: number;
    updatedAt: string;
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
  const action = useSubmit(
    "PURCHASE_SAVE",
    props.context ?? { businessUnitId: "", operatorId: "", year: 0 },
    "purchases",
  );
  const pending = action.pending;
  const [step, setStep] = useState(props.restored?.step ?? 1);
  const [date, setDate] = useState(
    props.restored?.date ?? props.initial?.purchasedDate ?? props.today,
  );
  const [supplierId, setSupplierId] = useState(
    props.restored?.supplierId ?? props.initial?.supplierId ?? props.suppliers[0]?.id ?? "",
  );
  const [locationId, setLocationId] = useState(
    props.restored?.locationId ?? props.initial?.storageLocationId ?? props.locations[0]?.id ?? "",
  );
  const [orderNumber, setOrderNumber] = useState(
    props.restored?.orderNumber ?? props.initial?.orderNumber ?? "",
  );
  const [total, setTotal] = useState(
    props.restored?.total ?? props.initial?.purchaseTotalJpy ?? "",
  );
  const [memo, setMemo] = useState(props.restored?.memo ?? props.initial?.memo ?? "");
  const [requestKey] = useState(
    () => props.restored?.requestKey ?? props.initial?.requestKey ?? uuid(),
  );
  const [products, setProducts] = useState<ProductDraft[]>(props.restored?.products ?? []);
  const [showProduct, setShowProduct] = useState(props.restored?.builder?.show ?? false);
  const [product, setProduct] = useState<Omit<ProductDraft, "variants">>(
    props.restored?.builder?.product ?? {
      clientRef: uuid(),
      itemCode: "",
      name: "",
      category: "",
      defaultConditionCategory: "UNSPECIFIED",
      defaultTrackingMode: "QUANTITY",
      memo: "",
    },
  );
  const [axes, setAxes] = useState<Axis[]>(
    props.restored?.builder?.axes ?? [
      { id: uuid(), name: "色", values: "" },
      { id: uuid(), name: "サイズ", values: "" },
    ],
  );
  const [generated, setGenerated] = useState<ProductDraft["variants"]>(
    props.restored?.builder?.generated ?? [],
  );
  const [supplierSearch, setSupplierSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");

  const allVariants = useMemo(
    () => [
      ...props.variants.map((variant) => ({
        key: `existing:${variant.id}`,
        label: variant.label,
        sourceName: variant.sourceName,
        value: { source: "EXISTING", variantId: variant.id } as VariantSelection,
      })),
      ...products.flatMap((item) =>
        item.variants.map((variant) => ({
          key: `new:${item.clientRef}:${variant.clientRef}`,
          label: `新規: ${item.name} / ${Object.values(variant.attributes).join("・") || "標準"}`,
          sourceName: item.name,
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
    conditionCategory: "UNSPECIFIED",
    conditionDescription: "",
    sourceName: allVariants[0]?.sourceName ?? "",
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
  const [lines, setLines] = useState<Line[]>(props.restored?.lines ?? props.initial?.lines ?? []);
  const [baseline] = useState(props.baseline ?? null);
  const [checking, setChecking] = useState(
    !!props.forceReview ||
      !!props.review?.code ||
      (!!props.restored &&
        props.restored.revision !== props.review?.baseline?.revision &&
        !!props.initial),
  );
  const snapshot: PurchaseUiSnapshot = {
    purchaseId: props.initial?.purchaseId,
    revision: props.restored?.revision ?? props.initial?.revision ?? 0,
    updatedAt: props.initial?.updatedAt,
    date,
    supplierId,
    locationId,
    orderNumber,
    total,
    memo,
    requestKey,
    products,
    lines,
    step,
    builder: { show: showProduct, product, axes, generated },
    replacedFields: props.restored?.replacedFields,
  };
  const draft = useWorkflowDraft(
    "PURCHASE",
    props.context ?? { businessUnitId: "", operatorId: "", year: 0 },
    snapshot,
    props.draft,
    !!props.context && !pending && !checking,
    baseline,
  );
  const comparison = usePurchaseReview({
    context: props.context ?? { businessUnitId: "", operatorId: "", year: 0 },
    purchaseId: props.initial?.purchaseId,
    draftId: draft.id,
    initial: props.review,
    trigger: draft.conflict
      ? `draft:${draft.conflict.revision}`
      : (draft.issue ?? action.result.code),
  });
  const conflicted =
    !!draft.conflict ||
    !!comparison.error ||
    !!comparison.review?.code ||
    (!!props.initial &&
      !!comparison.review?.baseline &&
      comparison.review.baseline.revision !== snapshot.revision) ||
    ["CONFLICT", "YEAR_LOCKED", "CONTEXT_CHANGED", "OWNERSHIP_CHANGED"].includes(
      action.result.code ?? "",
    );
  useEffect(() => {
    if (conflicted) queueMicrotask(() => setChecking(true));
  }, [conflicted]);
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
    baseSnapshot: baseline,
    ...(props.initial ? { purchaseId: props.initial.purchaseId } : {}),
    revision: props.restored?.revision ?? props.initial?.revision ?? 0,
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
    <HydratedForm
      onSubmit={(event) => {
        event.preventDefault();
        if (checking || conflicted) return;
        void action
          .submit(async () => ({
            ...payload,
            draftId: draft.id,
            draftRevision: await draft.prepare(),
          }))
          .finally(draft.resume);
      }}
      className="stack"
    >
      <p role="status" className="muted">
        {props.context ? draft.status : "入力中"}
        ・入庫するまで在庫は増えません。未入力・金額不一致でも途中保存します。
      </p>
      {(checking || conflicted) && props.context && (
        <PurchaseConflictPanel
          context={props.context}
          purchaseId={props.initial?.purchaseId}
          draftId={draft.id}
          baseline={baseline}
          local={snapshot}
          review={comparison.review}
          labels={props}
          error={comparison.error}
          refresh={comparison.refresh}
          prepare={() => draft.prepare(true)}
          blocked={action.pending}
        />
      )}
      {props.review?.previous && (
        <details className="card">
          <summary>選び直す前の手元入力を確認する</summary>
          <p>
            退避した入力です。選択：
            {props.review.previous.choice === "LATEST" ? "最新の保存内容" : "手元の入力"}
            。ここから仕入れ・在庫は更新されません。
          </p>
          <PurchaseComparison
            baseline={props.review.previous.baseline}
            remote={props.review.baseline}
            local={props.review.previous.input}
            labels={props.review.labels}
          />
        </details>
      )}
      {!!props.restored?.replacedFields?.length && (
        <p className="message">
          手元の入力を引き継ぎました。保存すると他端末の変更を置き換える項目：
          {props.restored.replacedFields.map((k) => purchaseFieldNames[k] ?? k).join("、")}
          。内容を確認してから保存してください。
        </p>
      )}
      {action.feedback}
      <fieldset
        disabled={pending || checking || conflicted}
        style={{ border: 0, padding: 0, minWidth: 0 }}
      >
        <nav className="button-row" aria-label="仕入れの入力段階">
          {["購入内容", "届いた商品", "内容確認"].map((label, i) => (
            <button
              key={label}
              type="button"
              className={step === i + 1 ? "button" : "button secondary"}
              onClick={() => setStep(i + 1)}
            >
              {i + 1}. {label}
            </button>
          ))}
        </nav>
        <input type="hidden" name="draftId" value={draft.id} />
        <input type="hidden" name="updatedAt" value={props.initial?.updatedAt ?? ""} />
        <input type="hidden" name="inputContext" value={JSON.stringify(props.context ?? null)} />
        {!props.suppliers.length || !props.locations.length ? (
          <p className="notice">
            登録には
            <SavedSettingsLink
              href="/settings/suppliers"
              returnTo={`/purchases/new?draft=${draft.id}`}
              prepare={draft.flush}
              resume={draft.resume}
            >
              仕入先
            </SavedSettingsLink>
            と
            <SavedSettingsLink
              href="/settings/storage-locations"
              returnTo={`/purchases/new?draft=${draft.id}`}
              prepare={draft.flush}
              resume={draft.resume}
            >
              保管場所
            </SavedSettingsLink>
            が必要です。
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

        <div className="form-grid" hidden={step === 2}>
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
            <span>仕入先を検索</span>
            <input
              type="search"
              value={supplierSearch}
              onChange={(e) => setSupplierSearch(e.target.value)}
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
              {props.suppliers
                .filter((s) => s.id === supplierId || s.label.includes(supplierSearch))
                .map((item) => (
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

        <section className="card stack" hidden={step === 1}>
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
                      setProduct({
                        ...product,
                        defaultTrackingMode: event.target.value as Tracking,
                      })
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
                  setLines((rows) => [
                    ...rows,
                    ...generated.map((variant) => ({
                      ...emptyLine(product.defaultTrackingMode === "UNIQUE" ? "used" : "new"),
                      variant: {
                        source: "NEW" as const,
                        productRef: product.clientRef,
                        variantRef: variant.clientRef,
                      },
                      sourceName: product.name,
                      conditionCategory: product.defaultConditionCategory,
                    })),
                  ]);
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
                商品を作成して仕入れに追加
              </button>
            </div>
          ) : null}
          {products.map((item) => (
            <p key={item.clientRef}>
              <strong>新規: {item.name}</strong>（{item.variants.length}バリアント）
            </p>
          ))}
        </section>

        <section className="stack" hidden={step === 1}>
          <label className="field">
            <span>選択候補の商品を検索</span>
            <input
              type="search"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
            />
          </label>
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
                同じ商品を数量で管理する
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setLines((rows) => [...rows, emptyLine("used")])}
              >
                1点ずつ状態・原価を管理する
              </button>
            </div>
          </div>
          {!lines.length ? (
            <p className="notice">
              管理方法を選んで明細を追加してください。新品・中古は別に指定できます。
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
                  <span>商品・色やサイズ</span>
                  <select
                    value={selectKey(line.variant)}
                    onChange={(event) => {
                      const found = allVariants.find((item) => item.key === event.target.value);
                      if (found)
                        update(index, { variant: found.value, sourceName: found.sourceName ?? "" });
                    }}
                    required
                  >
                    <option value="">選択してください</option>
                    {allVariants
                      .filter(
                        (v) => v.key === selectKey(line.variant) || v.label.includes(productSearch),
                      )
                      .map((item) => (
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
                  <span>管理方法</span>
                  <select
                    value={line.trackingMode}
                    onChange={(event) =>
                      update(index, { trackingMode: event.target.value as Tracking, quantity: 1 })
                    }
                  >
                    <option value="QUANTITY">同じ商品を数量で管理する</option>
                    <option value="UNIQUE">1点ずつ状態・原価を管理する</option>
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
                  <span>
                    {line.trackingMode === "QUANTITY" ? "明細原価総額" : "個別原価"}（円）
                  </span>
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
                    onChange={(event) =>
                      update(index, { conditionDescription: event.target.value })
                    }
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
              <MeasurementFields
                key={line.trackingMode}
                initial={
                  line.trackingMode === "QUANTITY"
                    ? (line.commonMeasurements ?? {})
                    : (line.measurements ?? {})
                }
                onChange={(value) =>
                  update(
                    index,
                    line.trackingMode === "QUANTITY"
                      ? { commonMeasurements: value }
                      : { measurements: value },
                  )
                }
              />
            </article>
          ))}
        </section>
        <label className="field">
          <span>メモ</span>
          <textarea
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            maxLength={1000}
          />
        </label>
        <input type="hidden" name="payload" value={JSON.stringify(payload)} />
        {step !== 1 && (
          <button
            type="button"
            className="button secondary"
            disabled={!lines.length || !/^\d+$/.test(total)}
            onClick={() =>
              setLines((rows) =>
                rows.map((line, i) => ({
                  ...line,
                  amountJpy: (
                    target / BigInt(rows.length) +
                    (BigInt(i) < target % BigInt(rows.length) ? 1n : 0n)
                  ).toString(),
                })),
              )
            }
          >
            総額を明細に均等配分する（端数は上の明細から1円ずつ）
          </button>
        )}
        {step < 3 && (
          <button type="button" className="button" onClick={() => setStep(step + 1)}>
            {step === 1 ? "届いた商品の入力へ" : "内容確認へ"}
          </button>
        )}
        <button
          className="button"
          hidden={step !== 3}
          disabled={pending || !ready || target !== allocated}
        >
          {pending ? "保存中…" : "内容を保存して入庫確認へ"}
        </button>
      </fieldset>
    </HydratedForm>
  );
}
