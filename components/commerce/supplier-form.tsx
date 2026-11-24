"use client";
import { useState } from "react";
import type { z } from "zod";
import type { supplierConfigSchema } from "@/lib/commerce/input";
import { allocationLabels, type AllocationMethod } from "@/lib/commerce/allocation";
import { MutationFeedback, useCommerceMutation } from "./mutation";
export function CounterpartyEditor({ initial }: { initial: z.infer<typeof supplierConfigSchema> }) {
  const [v, setV] = useState(initial),
    m = useCommerceMutation("SUPPLIER_CONFIG", v);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit();
      }}
    >
      <fieldset className="commerce-fieldset" disabled={m.busy || m.frozen}>
        <label className="field">
          取引先名
          <input
            name="name"
            required
            value={v.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
          />
        </label>
        <details className="commerce-disclosure">
          <summary>初期値・メモ</summary>
          <div className="commerce-fields">
            <label className="field">
              購入通貨
              <input
                name="currency"
                maxLength={3}
                value={v.currency}
                onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase() })}
              />
            </label>
            <label className="field">
              費用の配分方法
              <select
                name="allocationMethod"
                value={v.allocationMethod}
                onChange={(e) =>
                  setV({ ...v, allocationMethod: e.target.value as AllocationMethod })
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
          <label className="field">
            メモ
            <textarea
              name="memo"
              value={v.memo}
              onChange={(e) => setV({ ...v, memo: e.target.value })}
            />
          </label>
        </details>
        <label className="commerce-checkbox">
          <input
            type="checkbox"
            checked={v.active}
            onChange={(e) => setV({ ...v, active: e.target.checked })}
          />
          有効
        </label>
        <div className="commerce-action-row">
          <button className="button" type="submit">
            取引先を保存
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={m} />
    </form>
  );
}
