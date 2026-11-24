"use client";
import { useState, useSyncExternalStore } from "react";
import { useCommerceMutation, MutationFeedback } from "./mutation";
import type { SkuInput } from "@/lib/commerce/input";
const subscribe = () => () => {};
export function CatalogEditor({
  kind,
  initial,
  scope,
  locations = [],
}: {
  kind: "ITEM_SAVE" | "SUPPLY_SAVE";
  scope: string;
  initial: {
    context: SkuInput["context"];
    idempotencyKey: string;
    date: string;
    id: string;
    revision: number;
    name: string;
    memo: string;
    active: boolean;
    category?: string;
    locationId?: string;
  };
  locations?: { id: string; name: string }[];
}) {
  const [v, setV] = useState(initial),
    fallback = kind === "SUPPLY_SAVE" ? "/products?tab=supplies" : "/products";
  const target = useSyncExternalStore(
    subscribe,
    () => {
      try {
        const path = sessionStorage.getItem(`buppancho:list:last:${scope}:/products`);
        return path === "/products" || path?.startsWith("/products?") ? path : fallback;
      } catch {
        return fallback;
      }
    },
    () => fallback,
  );
  const m = useCommerceMutation(kind, v, undefined, target);
  return (
    <form
      className="commerce-editor commerce-catalog-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit();
      }}
    >
      <fieldset className="commerce-fieldset" disabled={m.busy || m.frozen}>
        <div className="commerce-fields">
          <label className="field">
            {kind === "ITEM_SAVE" ? "商品名" : "名称"}
            <input
              name="name"
              required
              maxLength={120}
              value={v.name}
              onChange={(e) => setV({ ...v, name: e.target.value })}
            />
            <span className="field-error">{m.feedback.fields?.name}</span>
          </label>
          {kind === "ITEM_SAVE" && (
            <>
              <label className="field">
                分類
                <input
                  name="category"
                  value={v.category ?? ""}
                  onChange={(e) => setV({ ...v, category: e.target.value })}
                />
              </label>
              <label className="field">
                既定保管場所（次回入力用）
                <select
                  name="locationId"
                  value={v.locationId ?? ""}
                  onChange={(e) => setV({ ...v, locationId: e.target.value })}
                >
                  <option value="">未設定</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
        <label className="field commerce-section">
          メモ
          <textarea
            name="memo"
            maxLength={2000}
            value={v.memo}
            onChange={(e) => setV({ ...v, memo: e.target.value })}
          />
        </label>
        <label className="commerce-checkbox">
          <input
            type="checkbox"
            checked={v.active}
            onChange={(e) => setV({ ...v, active: e.target.checked })}
          />
          有効
        </label>
        <footer className="commerce-save">
          <button className="button">変更を保存</button>
        </footer>
      </fieldset>
      <MutationFeedback mutation={m} />
    </form>
  );
}
