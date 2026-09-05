"use client";

import { useActionState, useState } from "react";
import { createInventoryItemAction, type InventoryActionState } from "@/app/inventory/actions";

export function InventoryItemForm({
  locations,
}: {
  locations: Array<{ id: string; name: string }>;
}) {
  const [state, action, pending] = useActionState(
    createInventoryItemAction,
    {} as InventoryActionState,
  );
  const [type, setType] = useState<"QUANTITY" | "UNIQUE">("QUANTITY");
  const [attributes, setAttributes] = useState("");
  const attributeMap = Object.fromEntries(
    attributes
      .split("\n")
      .map((line) => line.split(":", 2).map((value) => value.trim()))
      .filter((pair): pair is [string, string] => Boolean(pair[0] && pair[1]))
      .slice(0, 20),
  );
  return (
    <form action={action} className="stack">
      {state.error || state.success ? (
        <p className={`message ${state.error ? "error" : "success"}`} role="alert">
          {state.error ?? state.success}
        </p>
      ) : null}
      <div className="form-grid">
        <label className="field">
          <span>商品コード</span>
          <input
            name="itemCode"
            pattern="[A-Za-z0-9_-]+"
            maxLength={40}
            placeholder="空欄なら自動採番"
          />
        </label>
        <label className="field">
          <span>商品名</span>
          <input name="name" required maxLength={120} />
        </label>
        <label className="field">
          <span>管理種別</span>
          <select
            name="managementType"
            value={type}
            onChange={(event) => setType(event.target.value as typeof type)}
          >
            <option value="QUANTITY">数量商品</option>
            <option value="UNIQUE">個体商品</option>
          </select>
        </label>
        <label className="field">
          <span>既定の商品区分</span>
          <select name="defaultConditionCategory" defaultValue="UNSPECIFIED">
            <option value="UNSPECIFIED">未指定</option>
            <option value="NEW">新品</option>
            <option value="USED">中古</option>
          </select>
        </label>
        <label className="field">
          <span>管理原価方式</span>
          <input
            value={type === "QUANTITY" ? "移動平均法" : "個別法"}
            readOnly
            aria-readonly="true"
          />
        </label>
        <label className="field">
          <span>カテゴリ（任意）</span>
          <input name="category" maxLength={80} />
        </label>
        <label className="field">
          <span>既定保管場所</span>
          <select name="defaultStorageLocationId">
            <option value="">未設定</option>
            {locations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>属性（任意・1行に「項目: 値」）</span>
        <textarea
          value={attributes}
          onChange={(event) => setAttributes(event.target.value)}
          placeholder={"色: 黒\nサイズ: M"}
        />
      </label>
      <input type="hidden" name="attributes" value={JSON.stringify(attributeMap)} />
      <label className="field">
        <span>メモ</span>
        <textarea name="memo" maxLength={1000} />
      </label>
      <button className="button" disabled={pending}>
        {pending ? "登録中…" : "商品を登録"}
      </button>
    </form>
  );
}
