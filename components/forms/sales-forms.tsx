"use client";

import { useActionState, useMemo, useState } from "react";
import {
  cancelOrderAction,
  completeOrderAction,
  confirmSaleAction,
  createListingAction,
  createSalesSkuAction,
  returnOrderAction,
  shipOrderAction,
  updateListingPriceAction,
  type SalesActionState,
} from "@/app/sales/actions";
import { createClientUuid } from "@/lib/client-uuid";

function Message({ state }: { state: SalesActionState }) {
  return state.error || state.success ? (
    <p role="alert" className={`message ${state.error ? "error" : "success"}`}>
      {state.error ?? state.success}
    </p>
  ) : null;
}

export function SalesSkuForm({
  variants,
  units,
}: {
  variants: Array<{ id: string; label: string; availability: number }>;
  units: Array<{ id: string; label: string; availability: number }>;
}) {
  const [state, action, pending] = useActionState(createSalesSkuAction, {});
  const [skuType, setSkuType] = useState<"SINGLE" | "BUNDLE">("SINGLE");
  const [components, setComponents] = useState<
    Array<{ kind: "variant" | "unit"; id: string; requiredQuantity: number }>
  >([{ kind: "variant", id: variants[0]?.id ?? "", requiredQuantity: 1 }]);
  const options = useMemo(
    () => [
      ...variants.map((row) => ({ ...row, kind: "variant" as const })),
      ...units.map((row) => ({ ...row, kind: "unit" as const })),
    ],
    [variants, units],
  );
  return (
    <form action={action} className="card stack">
      <Message state={state} />
      <input type="hidden" name="idempotencyKey" value={createClientUuid()} />
      <input
        type="hidden"
        name="components"
        value={JSON.stringify(
          components.map((row) => ({
            itemVariantId: row.kind === "variant" ? row.id : "",
            uniqueStockUnitId: row.kind === "unit" ? row.id : "",
            requiredQuantity: row.kind === "unit" ? 1 : row.requiredQuantity,
          })),
        )}
      />
      <div className="form-grid">
        <label className="field">
          <span>SKU名</span>
          <input name="name" required maxLength={120} />
        </label>
        <label className="field">
          <span>種類</span>
          <select
            name="skuType"
            value={skuType}
            onChange={(e) => {
              const type = e.target.value as "SINGLE" | "BUNDLE";
              setSkuType(type);
              if (type === "SINGLE")
                setComponents((rows) => [
                  rows[0] ?? { kind: "variant", id: variants[0]?.id ?? "", requiredQuantity: 1 },
                ]);
            }}
          >
            <option value="SINGLE">単品</option>
            <option value="BUNDLE">セット</option>
          </select>
        </label>
        <label className="field">
          <span>想定価格（円）</span>
          <input name="expectedPriceJpy" inputMode="numeric" />
        </label>
      </div>
      <label className="field">
        <span>説明</span>
        <textarea name="description" />
      </label>
      <section className="stack">
        <h2>構成品</h2>
        {components.map((row, index) => (
          <div className="form-grid" key={index}>
            <label className="field">
              <span>商品・個体</span>
              <select
                value={`${row.kind}:${row.id}`}
                onChange={(e) => {
                  const [kind, id] = e.target.value.split(":") as ["variant" | "unit", string];
                  setComponents((rows) =>
                    rows.map((item, i) =>
                      i === index
                        ? {
                            kind,
                            id,
                            requiredQuantity: kind === "unit" ? 1 : item.requiredQuantity,
                          }
                        : item,
                    ),
                  );
                }}
                required
              >
                {options.map((option) => (
                  <option key={`${option.kind}:${option.id}`} value={`${option.kind}:${option.id}`}>
                    {option.label}（販売可能 {option.availability}）
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>必要数量</span>
              <input
                type="number"
                min={1}
                value={row.kind === "unit" ? 1 : row.requiredQuantity}
                disabled={row.kind === "unit"}
                onChange={(e) =>
                  setComponents((rows) =>
                    rows.map((item, i) =>
                      i === index ? { ...item, requiredQuantity: Number(e.target.value) } : item,
                    ),
                  )
                }
              />
            </label>
            {skuType === "BUNDLE" && components.length > 1 ? (
              <button
                type="button"
                className="button secondary"
                onClick={() => setComponents((rows) => rows.filter((_, i) => i !== index))}
              >
                削除
              </button>
            ) : null}
          </div>
        ))}
        {skuType === "BUNDLE" ? (
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              setComponents((rows) => [
                ...rows,
                { kind: "variant", id: variants[0]?.id ?? "", requiredQuantity: 1 },
              ])
            }
          >
            構成品を追加
          </button>
        ) : null}
      </section>
      <button className="button" disabled={pending || !options.length}>
        {pending ? "保存中…" : "販売SKUを登録"}
      </button>
    </form>
  );
}

export function ListingForm({
  skus,
  feeRate,
  today,
}: {
  skus: Array<{ id: string; label: string }>;
  feeRate: string;
  today: string;
}) {
  const [state, action, pending] = useActionState(createListingAction, {});
  return (
    <form action={action} className="card stack">
      <Message state={state} />
      <input type="hidden" name="idempotencyKey" value={createClientUuid()} />
      <div className="form-grid">
        <label className="field">
          <span>販売SKU</span>
          <select name="salesSkuId" required>
            {skus.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>出品日時</span>
          <input type="datetime-local" name="listedAt" defaultValue={today} required />
        </label>
        <label className="field">
          <span>状態</span>
          <select name="status">
            <option value="ACTIVE">出品中</option>
            <option value="DRAFT">下書き</option>
          </select>
        </label>
        <label className="field">
          <span>販売価格（円）</span>
          <input name="currentPriceJpy" inputMode="numeric" required />
        </label>
        <label className="field">
          <span>出品数量</span>
          <input type="number" name="listedQuantity" min={1} defaultValue={1} required />
        </label>
        <label className="field">
          <span>手数料率（%）</span>
          <input name="feeRatePercent" defaultValue={feeRate} required />
        </label>
        <label className="field">
          <span>想定送料（円）</span>
          <input name="expectedShippingJpy" inputMode="numeric" />
        </label>
        <label className="field">
          <span>外部出品ID</span>
          <input name="externalListingId" />
        </label>
      </div>
      <label className="field">
        <span>URL</span>
        <input type="url" name="url" />
      </label>
      <button className="button" disabled={pending || !skus.length}>
        {pending ? "保存中…" : "出品を登録"}
      </button>
    </form>
  );
}

export function PriceForm({ listingId }: { listingId: string }) {
  const [state, action, pending] = useActionState(updateListingPriceAction, {});
  return (
    <form action={action} className="stack">
      <Message state={state} />
      <input type="hidden" name="id" value={listingId} />
      <input type="hidden" name="idempotencyKey" value={createClientUuid()} />
      <div className="form-grid">
        <label className="field">
          <span>新価格（円）</span>
          <input name="priceJpy" required inputMode="numeric" />
        </label>
        <label className="field">
          <span>変更理由</span>
          <input name="reason" required />
        </label>
      </div>
      <button className="button" disabled={pending}>
        価格履歴へ追加
      </button>
    </form>
  );
}

export function SaleForm({
  listings,
  today,
}: {
  listings: Array<{ id: string; label: string }>;
  today: string;
}) {
  const [state, action, pending] = useActionState(confirmSaleAction, {});
  return (
    <form action={action} className="card stack">
      <Message state={state} />
      <input type="hidden" name="idempotencyKey" value={createClientUuid()} />
      <div className="form-grid">
        <label className="field">
          <span>出品</span>
          <select name="listingId" required>
            {listings.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>販売日時</span>
          <input type="datetime-local" name="orderedAt" defaultValue={today} required />
        </label>
        <label className="field">
          <span>数量</span>
          <input type="number" name="quantity" min={1} defaultValue={1} required />
        </label>
        <label className="field">
          <span>外部注文ID</span>
          <input name="externalOrderId" />
        </label>
        <label className="field">
          <span>値引（円）</span>
          <input name="discountJpy" defaultValue="0" required />
        </label>
        <label className="field">
          <span>梱包費（円）</span>
          <input name="packingJpy" />
        </label>
        <label className="field">
          <span>その他費用（円）</span>
          <input name="otherCostJpy" />
        </label>
      </div>
      <label className="field">
        <span>メモ</span>
        <textarea name="memo" />
      </label>
      <button className="button" disabled={pending || !listings.length}>
        {pending ? "引当中…" : "販売確定"}
      </button>
    </form>
  );
}

export function ShipForm({ orderId, today }: { orderId: string; today: string }) {
  const [state, action, pending] = useActionState(shipOrderAction, {});
  return (
    <form action={action} className="card stack">
      <h2>発送</h2>
      <Message state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="idempotencyKey" value={createClientUuid()} />
      <div className="form-grid">
        <label className="field">
          <span>発送日時</span>
          <input type="datetime-local" name="shippedAt" defaultValue={today} required />
        </label>
        <label className="field">
          <span>発送方法</span>
          <input name="shippingMethod" required />
        </label>
        <label className="field">
          <span>追跡番号</span>
          <input name="trackingNumber" />
        </label>
        <label className="field">
          <span>実送料（円）</span>
          <input name="actualShippingJpy" defaultValue="0" required />
        </label>
      </div>
      <button className="button" disabled={pending}>
        発送を記録
      </button>
    </form>
  );
}
export function CompleteForm({ orderId, today }: { orderId: string; today: string }) {
  const [state, action, pending] = useActionState(completeOrderAction, {});
  return (
    <form action={action} className="card stack">
      <h2>取引完了</h2>
      <Message state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="idempotencyKey" value={createClientUuid()} />
      <div className="form-grid">
        <label className="field">
          <span>完了日時</span>
          <input type="datetime-local" name="completedAt" defaultValue={today} required />
        </label>
        <label className="field">
          <span>確定手数料（円）</span>
          <input name="feeJpy" defaultValue="0" required />
        </label>
      </div>
      <button className="button" disabled={pending}>
        在庫出庫して完了
      </button>
    </form>
  );
}
export function CancelForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(cancelOrderAction, {});
  return (
    <form action={action} className="card stack">
      <h2>注文取消</h2>
      <Message state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="idempotencyKey" value={createClientUuid()} />
      <label className="field">
        <span>取消理由</span>
        <input name="reason" required />
      </label>
      <button className="button danger" disabled={pending}>
        引当を解除して取消
      </button>
    </form>
  );
}
export function ReturnForm({
  orderId,
  lines,
  today,
}: {
  orderId: string;
  lines: Array<{
    id: string;
    label: string;
    remaining: number;
    components: Array<{
      key: string;
      label: string;
      itemVariantId: string | null;
      uniqueStockUnitId: string | null;
    }>;
  }>;
  today: string;
}) {
  const [state, action, pending] = useActionState(returnOrderAction, {});
  const [lineId, setLineId] = useState(
    lines.find((row) => row.remaining > 0)?.id ?? lines[0]?.id ?? "",
  );
  const selectedLine = lines.find((row) => row.id === lineId) ?? lines[0];
  const [dispositions, setDispositions] = useState<Record<string, string>>({});
  const dispositionPayload = (selectedLine?.components ?? []).map((component) => ({
    itemVariantId: component.itemVariantId,
    uniqueStockUnitId: component.uniqueStockUnitId,
    disposition: dispositions[component.key] ?? "RESTOCK",
  }));
  return (
    <form action={action} className="card stack">
      <h2>返品</h2>
      <Message state={state} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="idempotencyKey" value={createClientUuid()} />
      <input type="hidden" name="dispositions" value={JSON.stringify(dispositionPayload)} />
      <div className="form-grid">
        <label className="field">
          <span>明細</span>
          <select name="lineId" value={lineId} onChange={(event) => setLineId(event.target.value)}>
            {lines.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}（残り{row.remaining}）
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>数量</span>
          <input type="number" name="quantity" min={1} defaultValue={1} />
        </label>
        <label className="field">
          <span>返品日時</span>
          <input type="datetime-local" name="returnedAt" defaultValue={today} />
        </label>
        {(selectedLine?.components ?? []).map((component) => (
          <label className="field" key={component.key}>
            <span>{component.label}の処理</span>
            <select
              value={dispositions[component.key] ?? "RESTOCK"}
              onChange={(event) =>
                setDispositions((current) => ({
                  ...current,
                  [component.key]: event.target.value,
                }))
              }
            >
              <option value="RESTOCK">良品戻し</option>
              <option value="DEFECTIVE">不良品</option>
              <option value="DISPOSED">廃棄</option>
            </select>
          </label>
        ))}
        <label className="field">
          <span>売上返金（円）</span>
          <input name="salesRefundJpy" defaultValue="0" />
        </label>
        <label className="field">
          <span>手数料返還（円）</span>
          <input name="feeRefundJpy" defaultValue="0" />
        </label>
        <label className="field">
          <span>送料返還（円）</span>
          <input name="shippingRefundJpy" defaultValue="0" />
        </label>
      </div>
      <label className="field">
        <span>メモ</span>
        <textarea name="memo" />
      </label>
      <button
        className="button danger"
        disabled={pending || !lines.some((row) => row.remaining > 0)}
      >
        返品を記録
      </button>
    </form>
  );
}
