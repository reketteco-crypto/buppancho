"use client";
import { useState } from "react";
import type { z } from "zod";
import type { categorySchema } from "@/lib/commerce/input";
import { MutationFeedback, useCommerceMutation } from "./mutation";
export function CategoryEditor({ initial }: { initial: z.infer<typeof categorySchema> }) {
  const [v, setV] = useState(initial),
    m = useCommerceMutation("CATEGORY_SAVE", v);
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
            項目名
            <input
              name="name"
              required
              value={v.name}
              onChange={(e) => setV({ ...v, name: e.target.value })}
            />
          </label>
          <label className="field">
            種類
            <select
              name="kind"
              disabled={!!v.id}
              value={v.kind}
              onChange={(e) => setV({ ...v, kind: e.target.value as typeof v.kind })}
            >
              <option value="EXPENSE">費用</option>
              <option value="INCOME">収入</option>
            </select>
          </label>
        </div>
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
            項目を保存
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={m} />
    </form>
  );
}
