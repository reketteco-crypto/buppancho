"use client";
import { ContextHelp, SearchSelect } from "./ui";
import { SkuSupplies } from "./sku-supplies";
import type { SupplyPrice } from "@/lib/commerce/supplies";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Precise } from "@/lib/commerce/allocation";
import type { SkuInput } from "@/lib/commerce/input";
import type { ChannelOption, MethodOption } from "@/lib/commerce/view";
import { MutationFeedback, useCommerceMutation, useCostEstimate, moneyLabel } from "./mutation";

export type StockChoice = {
  id: string;
  variantId: string | null;
  unitId: string | null;
  name: string;
  label: string;
  quantity: number;
};
export function SkuEditor({
  initial,
  products,
  channels,
  methods,
  supplies = [],
}: {
  initial: SkuInput;
  supplies?: SupplyPrice[];
  products: StockChoice[];
  channels: ChannelOption[];
  methods: MethodOption[];
}) {
  const [values, setValues] = useState(initial),
    mutation = useCommerceMutation("SKU_SAVE", values);
  const estimate = useCostEstimate(
    { context: values.context, components: values.components },
    values.components.every(
      (p) => (!!p.itemVariantId || !!p.uniqueStockUnitId) && p.requiredQuantity > 0,
    ),
  );
  let materialCost: bigint | null = 0n,
    materialFinal = true;
  try {
    let sum = new Precise(0);
    for (const row of values.supplies ?? []) {
      const source = supplies.find((s) => s.id === row.supplyItemId),
        unit = row.unitCost || source?.unitCost || "";
      if (unit === "") {
        materialCost = null;
        materialFinal = false;
        break;
      }
      sum = sum.plus(new Precise(unit).mul(row.quantity));
      if (row.unitCost === "" && !source?.final) materialFinal = false;
    }
    if (materialCost !== null) materialCost = BigInt(sum.toDecimalPlaces(0).toFixed(0));
  } catch {
    materialCost = null;
    materialFinal = false;
  }
  const change = (next: Partial<SkuInput>) => setValues((v) => ({ ...v, ...next }));
  return (
    <form
      className="commerce-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void mutation.submit();
      }}
    >
      <ContextHelp title="単品・セットの販売商品とは">
        <p>
          売るときの単位を登録します。1点で売る場合は商品1点、30点セットで売る場合は使用数30にします。この登録では在庫を増減しません。
        </p>
      </ContextHelp>
      <fieldset className="commerce-fieldset" disabled={mutation.busy || mutation.frozen}>
        <div className="commerce-fields">
          <label className="field">
            販売商品名
            <input
              name="name"
              required
              value={values.name}
              maxLength={120}
              onChange={(e) => change({ name: e.target.value })}
            />
          </label>
          <label className="field">
            標準の販売価格（円）
            <input
              name="price"
              inputMode="numeric"
              value={values.price}
              placeholder="未設定"
              onChange={(e) => change({ price: e.target.value.replace(/[^\d]/g, "") })}
            />
          </label>
        </div>
        <section className="commerce-section">
          <div className="commerce-section-heading">
            <h2>商品構成</h2>
            <button
              type="button"
              className="commerce-text-button"
              onClick={() =>
                change({
                  components: [
                    ...values.components,
                    { itemVariantId: null, uniqueStockUnitId: null, requiredQuantity: 1 },
                  ],
                })
              }
            >
              <Plus size={16} />
              商品を追加
            </button>
          </div>
          {values.components.map((row, index) => (
            <div className="commerce-component" key={index}>
              <SearchSelect
                limit={products.length || 50}
                label="商品"
                name={`components.${index}.itemVariantId`}
                required
                value={row.itemVariantId ?? row.uniqueStockUnitId ?? ""}
                options={products.map((p) => ({ id: p.id, label: p.label }))}
                onChange={(id) => {
                  const p = products.find((p) => p.id === id);
                  change({
                    components: values.components.map((r, i) =>
                      i === index
                        ? {
                            itemVariantId: p?.variantId ?? null,
                            uniqueStockUnitId: p?.unitId ?? null,
                            requiredQuantity: p?.unitId ? 1 : r.requiredQuantity,
                          }
                        : r,
                    ),
                  });
                }}
              />
              <label className="field">
                使用数
                <input
                  type="number"
                  min="1"
                  max="100000"
                  required
                  readOnly={!!row.uniqueStockUnitId}
                  value={row.requiredQuantity}
                  onChange={(e) =>
                    change({
                      components: values.components.map((r, i) =>
                        i === index ? { ...r, requiredQuantity: Number(e.target.value) } : r,
                      ),
                    })
                  }
                />
              </label>
              {values.components.length > 1 && (
                <button
                  className="commerce-text-button"
                  type="button"
                  onClick={() =>
                    change({ components: values.components.filter((_, i) => i !== index) })
                  }
                >
                  削除
                </button>
              )}
            </div>
          ))}
        </section>
        <details className="commerce-disclosure">
          <summary>販路別の価格・配送</summary>
          {channels.map((channel) => {
            const current = values.channels.find((c) => c.channelId === channel.id);
            const update = (next: Partial<SkuInput["channels"][number]>) =>
              change({
                channels: current
                  ? values.channels.map((c) => (c.channelId === channel.id ? { ...c, ...next } : c))
                  : [
                      ...values.channels,
                      {
                        channelId: channel.id,
                        price: "",
                        shipping: "",
                        deliveryMethodId: "",
                        ...next,
                      },
                    ],
              });
            const price = current?.price || values.price;
            const shipping =
              current?.shipping ||
              methods.find((m) => m.id === (current?.deliveryMethodId || channel.methodId))
                ?.shipping ||
              channel.shipping;
            const fee =
              price !== "" && channel.rate !== ""
                ? new Precise(price).mul(channel.rate).div(100).floor().toFixed(0)
                : null;
            const profit =
              estimate?.cost != null && materialCost !== null && fee !== null && shipping !== ""
                ? BigInt(price) -
                  BigInt(fee) -
                  BigInt(shipping) -
                  BigInt(estimate.cost) -
                  materialCost!
                : null;
            return (
              <div className="commerce-charge-editor" key={channel.id}>
                <h2>{channel.name}</h2>
                <div className="commerce-fields commerce-section">
                  <label className="field">
                    販売価格（円）
                    <input
                      inputMode="numeric"
                      placeholder="標準価格を使用"
                      value={current?.price ?? ""}
                      onChange={(e) => update({ price: e.target.value.replace(/[^\d]/g, "") })}
                    />
                  </label>
                  <label className="field">
                    配送方法
                    <select
                      value={current?.deliveryMethodId ?? ""}
                      onChange={(e) => {
                        const m = methods.find((m) => m.id === e.target.value);
                        update({
                          deliveryMethodId: e.target.value,
                          ...(m ? { shipping: m.shipping } : {}),
                        });
                      }}
                    >
                      <option value="">販路の設定を使用</option>
                      {methods.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    標準送料（円）
                    <input
                      inputMode="numeric"
                      placeholder="販路の設定を使用"
                      value={current?.shipping ?? ""}
                      onChange={(e) => update({ shipping: e.target.value.replace(/[^\d]/g, "") })}
                    />
                  </label>
                </div>
                <p className="commerce-caption">
                  見込み利益 {moneyLabel(profit)}
                  {estimate && (!estimate.final || !materialFinal) ? " · 原価は暫定" : ""}
                </p>
              </div>
            );
          })}
        </details>
        <SkuSupplies
          value={values.supplies ?? []}
          onChange={(supplies) => change({ supplies })}
          items={supplies.filter((s) => s.kind === "MATERIAL")}
        />
        <div className="commerce-save">
          <div>
            <span className="commerce-secondary">
              商品・資材原価{estimate && (!estimate.final || !materialFinal) ? "・暫定" : ""}
            </span>
            <strong className="commerce-total">
              {moneyLabel(
                estimate?.cost == null || materialCost === null
                  ? null
                  : BigInt(estimate.cost) + materialCost,
              )}
            </strong>
          </div>
          <button type="submit" className="button">
            販売商品を保存
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={mutation} />
    </form>
  );
}

export { BatchSkuEditor } from "./catalog-selection";
