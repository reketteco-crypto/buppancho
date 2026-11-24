"use client";
import { useState } from "react";
import type { z } from "zod";
import type { purchaseReturnSchema } from "@/lib/commerce/input";
import { MutationFeedback, useCommerceMutation } from "./mutation";
export function SupplierReturnEditor({
  initial,
  receipts,
}: {
  initial: z.infer<typeof purchaseReturnSchema>;
  receipts: { id: string; name: string; quantity: number }[];
}) {
  const [v, setV] = useState(initial),
    m = useCommerceMutation("PURCHASE_RETURN", v);
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
            返送日
            <input
              name="date"
              type="date"
              required
              value={v.date}
              onChange={(e) => setV({ ...v, date: e.target.value })}
            />
          </label>
          <label className="field">
            返送するもの
            <select
              name="receiptLineId"
              value={v.receiptLineId}
              onChange={(e) => setV({ ...v, receiptLineId: e.target.value, quantity: 1 })}
            >
              {receipts.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name} · 最大{r.quantity}点
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            返送数量
            <input
              name="quantity"
              type="number"
              min="1"
              max={receipts.find((r) => r.id === v.receiptLineId)?.quantity}
              value={v.quantity}
              onChange={(e) => setV({ ...v, quantity: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            返金額（円）
            <input
              name="refund"
              inputMode="numeric"
              placeholder="未確認"
              value={v.refund}
              onChange={(e) => setV({ ...v, refund: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          理由
          <input
            name="reason"
            required
            value={v.reason}
            onChange={(e) => setV({ ...v, reason: e.target.value })}
          />
        </label>
        <div className="commerce-action-row">
          <button className="button" type="submit">
            返送を記録
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={m} />
    </form>
  );
}
