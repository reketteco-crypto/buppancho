"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ContextHelp, SearchSelect } from "./ui";
import { Precise } from "@/lib/commerce/allocation";
import type { SaleInput } from "@/lib/commerce/input";
import type { ChannelOption, MethodOption, SkuOption } from "@/lib/commerce/view";
import { MutationFeedback, moneyLabel, useCommerceMutation, useCostEstimate } from "./mutation";

export function SaleEditor({
  initial,
  draftId,
  draftRevision,
  skus,
  channels,
  methods,
}: {
  initial: SaleInput;
  draftId: string;
  draftRevision: number;
  skus: SkuOption[];
  channels: ChannelOption[];
  methods: MethodOption[];
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial),
    [dirty, setDirty] = useState(false),
    [manualFee, setManualFee] = useState(draftRevision > 0),
    [manualPrice, setManualPrice] = useState(draftRevision > 0),
    [manualShipping, setManualShipping] = useState(draftRevision > 0),
    [manualMethod, setManualMethod] = useState(draftRevision > 0);
  const estimate = useCostEstimate(
    {
      context: values.context,
      skuId: values.skuId,
      quantity: values.quantity,
      date: values.date,
      supplyQuantities: values.supplyQuantities,
    },
    !!values.skuId && values.quantity > 0,
  );
  const mutation = useCommerceMutation(
    "SALE",
    { ...values, materialQuote: estimate?.materials?.quote ?? values.materialQuote },
    {
      draftId,
      revision: draftRevision,
      kind: "COMMERCE_SALE",
      dirty,
    },
  );
  const feeFor = (price: string, quantity: number, channelId: string) => {
    const rate = channels.find((c) => c.id === channelId)?.rate;
    return rate === undefined || rate === "" || price === ""
      ? ""
      : new Precise(price)
          .mul(quantity || 0)
          .mul(rate)
          .div(100)
          .floor()
          .toFixed(0);
  };
  const change = (next: Partial<SaleInput>) => {
    setValues((v) => {
      const result = { ...v, ...next };
      if (!manualFee && ("price" in next || "quantity" in next))
        result.fee = feeFor(result.price, result.quantity, result.channelId);
      return result;
    });
    setDirty(true);
  };
  const defaults = (skuId: string, channelId: string, replace = false) => {
    const sku = skus.find((s) => s.id === skuId),
      channel = channels.find((c) => c.id === channelId),
      pref = sku?.channels.find((p) => p.channelId === channelId);
    const price = !replace && manualPrice ? values.price : pref?.price || sku?.price || "";
    const methodId =
      !replace && manualMethod
        ? values.deliveryMethodId
        : pref?.methodId || channel?.methodId || "";
    change({
      skuId,
      ...(skuId !== values.skuId
        ? { supplyQuantities: {}, materialQuote: undefined, valuationPosition: undefined }
        : {}),
      skuRevision: sku?.revision ?? 0,
      channelId,
      channelRevision: channel?.revision ?? 0,
      price,
      shipping:
        !replace && manualShipping
          ? values.shipping
          : pref?.shipping ||
            methods.find((m) => m.id === methodId)?.shipping ||
            channel?.shipping ||
            "",
      deliveryMethodId: methodId,
      fee: !replace && manualFee ? values.fee : feeFor(price, values.quantity, channelId),
    });
    if (replace) {
      setManualFee(false);
      setManualPrice(false);
      setManualShipping(false);
      setManualMethod(false);
    }
  };
  if (!skus.length || !channels.length)
    return (
      <div className="commerce-empty">
        <h2>{!skus.length ? "販売する商品を準備しましょう" : "販路を登録しましょう"}</h2>
        <p>
          {!skus.length
            ? "購入した在庫商品を、単品またはセットの販売商品として登録すると販売を記録できます。"
            : "販売先と手数料などの設定を登録してください。"}
        </p>
        <button
          type="button"
          className="button"
          disabled={!mutation.ready || mutation.busy || mutation.frozen}
          onClick={async () => {
            if (await mutation.saveDraft())
              router.push(
                `${!skus.length ? "/products" : "/settings/sales-channels"}?returnTo=${encodeURIComponent(`/sales/new?draft=${draftId}`)}`,
              );
          }}
        >
          {!skus.length ? "在庫商品から販売商品を準備" : "販路を登録"}
        </button>
        <MutationFeedback mutation={mutation} />
      </div>
    );
  const selected = skus.find((s) => s.id === values.skuId);
  const total = new Precise(values.price || 0).mul(values.quantity || 0).toFixed(0);
  return (
    <form
      className="commerce-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void mutation.submit();
      }}
    >
      <fieldset
        className="commerce-fieldset"
        disabled={!mutation.ready || mutation.busy || mutation.frozen}
      >
        <p className="commerce-caption">
          完了した販売を記録します。売上の入金は、保存後の販売詳細から別に記録します。
        </p>
        <SearchSelect
          limit={skus.length || 50}
          label="販売する商品"
          name="skuId"
          value={values.skuId}
          required
          placeholder="販売する商品を選択"
          options={skus.map((s) => ({ id: s.id, label: `${s.name} · ${s.code}` }))}
          onChange={(skuId) => defaults(skuId, values.channelId)}
        />
        <ContextHelp title="販売する商品・価格の設定について">
          <p>
            単品・セットなど、販売する単位を登録したものをSKUと呼びます。数量はその販売単位の数です。
          </p>
          <p>手入力した金額と再開した下書きの金額は、商品や販路を変えても保持します。</p>
          <button
            type="button"
            className="button secondary"
            disabled={!values.skuId}
            onClick={() => defaults(values.skuId, values.channelId, true)}
          >
            入力済みの価格・送料を設定値に置き換える
          </button>
        </ContextHelp>
        {selected && (
          <p className="commerce-caption">
            現在の販売可能数 {selected.available.toLocaleString("ja-JP")} 点
            {selected.composition ? ` · ${selected.composition}` : ""}
          </p>
        )}
        <div className="commerce-fields commerce-section">
          <label className="field">
            完了日
            <input
              name="date"
              required
              type="date"
              value={values.date}
              onChange={(e) => {
                change({ date: e.target.value, valuationPosition: undefined });
                mutation.setPosition("");
              }}
            />
          </label>
          <label className="field">
            数量
            <input
              name="quantity"
              required
              type="number"
              min="1"
              max="1000000"
              value={values.quantity || ""}
              onChange={(e) => change({ quantity: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            販路
            <select
              name="channelId"
              required
              value={values.channelId}
              onChange={(e) => defaults(values.skuId, e.target.value)}
            >
              <option value="">選択してください</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {values.quantity > 1 ? "商品単価（円）" : "商品代金（円）"}
            <input
              name="price"
              required
              inputMode="numeric"
              pattern="[0-9]+"
              value={values.price}
              onChange={(e) => {
                setManualPrice(true);
                change({ price: e.target.value.replace(/[^\d]/g, "") });
              }}
            />
          </label>
        </div>
        <div className="commerce-fields commerce-section">
          <label className="field">
            販売手数料（円）
            <input
              name="fee"
              inputMode="numeric"
              placeholder="未確認"
              value={values.fee}
              onChange={(e) => {
                setManualFee(true);
                change({ fee: e.target.value.replace(/[^\d]/g, "") });
              }}
            />
          </label>
          <label className="field">
            送料（円）
            <input
              name="shipping"
              inputMode="numeric"
              placeholder="未確認"
              value={values.shipping}
              onChange={(e) => {
                setManualShipping(true);
                change({ shipping: e.target.value.replace(/[^\d]/g, "") });
              }}
            />
          </label>
        </div>
        <details className="commerce-disclosure">
          <summary>配送方法・商品ID・購入者・メモ</summary>
          <div className="commerce-fields">
            <label className="field">
              配送方法
              <select
                name="deliveryMethodId"
                value={values.deliveryMethodId}
                onChange={(e) => {
                  const method = methods.find((m) => m.id === e.target.value);
                  setManualMethod(true);
                  change({
                    deliveryMethodId: e.target.value,
                    ...(!manualShipping && method?.shipping !== "" && method
                      ? { shipping: method.shipping }
                      : {}),
                  });
                }}
              >
                <option value="">未指定</option>
                {methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              商品ID
              <input
                name="externalId"
                value={values.externalId}
                onChange={(e) => change({ externalId: e.target.value })}
              />
            </label>
            <label className="field">
              購入者
              <input
                name="buyer"
                value={values.buyer}
                onChange={(e) => change({ buyer: e.target.value })}
              />
            </label>
            <label className="field">
              メモ
              <textarea
                name="memo"
                value={values.memo}
                onChange={(e) => change({ memo: e.target.value })}
              />
            </label>
          </div>
        </details>
        {!!estimate?.materials?.uses.length && (
          <details className="commerce-disclosure">
            <summary>
              資材の使用
              <span>
                {estimate.materials.cost === null
                  ? "原価未確認"
                  : moneyLabel(estimate.materials.cost)}
              </span>
            </summary>
            {estimate.materials.uses.map((u) => (
              <div className="commerce-row" key={u.settingId}>
                <div>
                  <strong>{u.name}</strong>
                  <small className="commerce-secondary">
                    1単位 {u.unitCost === "" ? "未確認" : `¥${u.unitCost}`}
                  </small>
                </div>
                <label className="field">
                  使用量
                  <input
                    inputMode="decimal"
                    value={values.supplyQuantities?.[u.settingId] ?? u.quantity}
                    onChange={(e) =>
                      change({
                        supplyQuantities: {
                          ...values.supplyQuantities,
                          [u.settingId]: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              </div>
            ))}
          </details>
        )}
        <footer className="commerce-save">
          <div>
            <span className="commerce-secondary">売上合計</span>
            <strong className="commerce-total">{moneyLabel(total)}</strong>
          </div>
          <button
            className="button"
            type="submit"
            disabled={!!selected?.hasSupplies && !estimate?.materials}
          >
            {mutation.busy ? "保存中…" : "販売を記録"}
          </button>
        </footer>
        {!!selected?.hasSupplies && !estimate?.materials && (
          <p className="field-error" role="status">
            資材原価を確認しています。確認できるまで販売は記録できません。商品・数量・完了日を確認してください。
          </p>
        )}
        {estimate?.cost !== null &&
          estimate?.cost !== undefined &&
          (!estimate.materials || estimate.materials.cost !== null) &&
          values.fee !== "" &&
          values.shipping !== "" && (
            <p className="commerce-caption">
              見込み利益{" "}
              {moneyLabel(
                BigInt(total) -
                  BigInt(values.fee) -
                  BigInt(values.shipping) -
                  BigInt(estimate.cost) -
                  BigInt(estimate.materials?.cost ?? "0"),
              )}
              {!estimate.final || estimate.materials?.final === false ? " · 原価は暫定" : ""}
            </p>
          )}
      </fieldset>
      <MutationFeedback mutation={mutation} />
      {selected?.hasSupplies && mutation.feedback.code === "CONFLICT" && (
        <button
          type="button"
          className="commerce-text-button"
          disabled={!estimate}
          onClick={() => estimate?.refresh()}
        >
          資材の単価候補を再取得
        </button>
      )}
      {mutation.draftState && (
        <p className="commerce-caption" role="status">
          {mutation.draftState}
        </p>
      )}
    </form>
  );
}
