"use client";
import { useState } from "react";
import type { z } from "zod";
import type { buyCancelSchema } from "@/lib/commerce/input";
import { MutationFeedback, useCommerceMutation } from "./mutation";
export function PurchaseCancelEditor({
  initial,
}: {
  initial: Omit<z.infer<typeof buyCancelSchema>, "confirmed">;
}) {
  const [v, setV] = useState({ ...initial, confirmed: false }),
    m = useCommerceMutation("BUY_CANCEL", v);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit();
      }}
    >
      <fieldset className="commerce-fieldset" disabled={m.busy || m.frozen}>
        <p className="commerce-caption">
          在庫が未使用で、決済前の誤登録を取り消します。実際の返送・返金は別に記録してください。
        </p>
        <div className="commerce-fields">
          <label className="field">
            取消日
            <input
              name="date"
              type="date"
              required
              value={v.date}
              onChange={(e) => setV({ ...v, date: e.target.value, valuationPosition: undefined })}
            />
          </label>
          <label className="field">
            取消理由
            <input
              name="reason"
              required
              value={v.reason}
              onChange={(e) => setV({ ...v, reason: e.target.value })}
            />
          </label>
        </div>
        <label className="commerce-checkbox">
          <input
            type="checkbox"
            required
            checked={v.confirmed}
            onChange={(e) => setV({ ...v, confirmed: e.target.checked })}
          />
          元の記録を残し、入庫分を取り消すことを確認しました
        </label>
        <div className="commerce-action-row">
          <button type="submit" className="button secondary">
            購入を取り消す
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={m} />
    </form>
  );
}
