"use client";
import { useState } from "react";
import type { z } from "zod";
import type { channelSchema, methodSchema } from "@/lib/commerce/input";
import { allocationLabels, type AllocationMethod } from "@/lib/commerce/allocation";
import type { MethodOption } from "@/lib/commerce/view";
import { MutationFeedback, useCommerceMutation } from "./mutation";

export function ChannelEditor({
  initial,
  methods,
  accounts = [],
}: {
  initial: z.infer<typeof channelSchema>;
  methods: MethodOption[];
  accounts?: { id: string; name: string }[];
}) {
  const [values, setValues] = useState(initial),
    mutation = useCommerceMutation("CHANNEL_SAVE", values);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void mutation.submit();
      }}
    >
      <fieldset disabled={mutation.busy || mutation.frozen} className="commerce-fieldset">
        <div className="commerce-fields">
          <label className="field">
            販路名
            <input
              name="name"
              required
              value={values.name}
              onChange={(e) => setValues({ ...values, name: e.target.value })}
            />
          </label>
          <label className="field">
            標準手数料率（%）
            <input
              name="feeRate"
              inputMode="decimal"
              value={values.feeRate}
              placeholder="未設定"
              onChange={(e) => setValues({ ...values, feeRate: e.target.value })}
            />
          </label>
          <label className="field">
            標準の配送方法
            <select
              name="deliveryMethodId"
              value={values.deliveryMethodId}
              onChange={(e) => setValues({ ...values, deliveryMethodId: e.target.value })}
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
            標準送料（円）
            <input
              name="shipping"
              inputMode="numeric"
              value={values.shipping}
              placeholder="未設定"
              onChange={(e) =>
                setValues({ ...values, shipping: e.target.value.replace(/[^\d]/g, "") })
              }
            />
          </label>
        </div>
        <details className="commerce-disclosure">
          <summary>受取口座・精算方法</summary>
          <label className="field">
            受取口座
            <select
              name="receivingAccountId"
              value={values.receivingAccountId || ""}
              onChange={(e) => setValues({ ...values, receivingAccountId: e.target.value })}
            >
              <option value="">決済時に選択</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="commerce-checkbox">
            <input
              type="checkbox"
              checked={values.feeDeducted ?? true}
              onChange={(e) => setValues({ ...values, feeDeducted: e.target.checked })}
            />
            販売手数料を売上から差し引く
          </label>
          <label className="commerce-checkbox">
            <input
              type="checkbox"
              checked={values.shippingDeducted ?? true}
              onChange={(e) => setValues({ ...values, shippingDeducted: e.target.checked })}
            />
            送料を売上から差し引く
          </label>
        </details>
        <div className="commerce-action-row">
          <button type="submit" className="button">
            販路を保存
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={mutation} />
    </form>
  );
}

export function DeliveryMethodEditor({ initial }: { initial: z.infer<typeof methodSchema> }) {
  const [values, setValues] = useState(initial),
    mutation = useCommerceMutation("DELIVERY_METHOD", values);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void mutation.submit();
      }}
    >
      <fieldset disabled={mutation.busy || mutation.frozen} className="commerce-fieldset">
        <div className="commerce-fields">
          <label className="field">
            配送方法名
            <input
              name="name"
              required
              value={values.name}
              onChange={(e) => setValues({ ...values, name: e.target.value })}
            />
          </label>
          <label className="field">
            標準送料（円）
            <input
              name="shipping"
              inputMode="numeric"
              value={values.shipping}
              placeholder="未設定"
              onChange={(e) =>
                setValues({ ...values, shipping: e.target.value.replace(/[^\d]/g, "") })
              }
            />
          </label>
          <label className="field">
            購入費用の配分方法
            <select
              name="allocationMethod"
              value={values.allocationMethod}
              onChange={(e) =>
                setValues({ ...values, allocationMethod: e.target.value as AllocationMethod })
              }
            >
              {Object.entries(allocationLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="commerce-action-row">
          <button type="submit" className="button">
            配送方法を保存
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={mutation} />
    </form>
  );
}
