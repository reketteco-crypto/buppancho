"use client";
import { useState } from "react";
import type { z } from "zod";
import type { materialUseSchema } from "@/lib/commerce/input";
import type { SupplyPrice } from "@/lib/commerce/supplies";
import { MutationFeedback, useCommerceMutation } from "./mutation";
export function MaterialUseEditor({
  initial,
  supplies,
}: {
  initial: z.infer<typeof materialUseSchema>;
  supplies: SupplyPrice[];
}) {
  const [v, setV] = useState(initial),
    m = useCommerceMutation("MATERIAL_USE", v);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit();
      }}
    >
      <fieldset className="commerce-fieldset" disabled={m.busy || m.frozen}>
        <div className="commerce-fields">
          <label className="field">
            使用日
            <input
              name="date"
              required
              type="date"
              value={v.date}
              onChange={(e) => setV({ ...v, date: e.target.value })}
            />
          </label>
          <label className="field">
            資材
            <select
              name="supplyItemId"
              required
              disabled={!!v.supersedesId}
              value={v.supplyItemId}
              onChange={(e) => {
                const s = supplies.find((s) => s.id === e.target.value);
                setV({
                  ...v,
                  supplyItemId: e.target.value,
                  unitCost: s?.unitCost || "",
                  sourceLineId: s?.sourceLineId || null,
                  manualPrice: false,
                });
              }}
            >
              <option value="">選択してください</option>
              {supplies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            使用量
            <input
              name="quantity"
              required
              inputMode="decimal"
              value={v.quantity}
              onChange={(e) => setV({ ...v, quantity: e.target.value })}
            />
          </label>
          <label className="field">
            使用単価（円）
            <input
              name="unitCost"
              inputMode="decimal"
              placeholder="未確認"
              value={v.unitCost}
              onChange={(e) => setV({ ...v, unitCost: e.target.value, manualPrice: true })}
            />
          </label>
        </div>
        <label className="field">
          用途
          <select
            name="purpose"
            value={v.purpose}
            onChange={(e) => setV({ ...v, purpose: e.target.value as typeof v.purpose })}
          >
            <option value="PACKING">梱包用</option>
            <option value="COMPONENT">商品構成用</option>
          </select>
        </label>
        <label className="field">
          理由
          <input
            name="reason"
            required
            placeholder="梱包のやり直しなど"
            value={v.reason}
            onChange={(e) => setV({ ...v, reason: e.target.value })}
          />
        </label>
        <div className="commerce-action-row">
          <button className="button" type="submit">
            資材使用を保存
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={m} />
    </form>
  );
}
