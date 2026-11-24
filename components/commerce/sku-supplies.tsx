"use client";
import type { SkuInput } from "@/lib/commerce/input";
import type { SupplyPrice } from "@/lib/commerce/supplies";
export function SkuSupplies({
  value,
  onChange,
  items,
}: {
  value: NonNullable<SkuInput["supplies"]>;
  onChange: (next: NonNullable<SkuInput["supplies"]>) => void;
  items: SupplyPrice[];
}) {
  return (
    <details className="commerce-disclosure">
      <summary>
        資材・梱包<span>{value.length ? `${value.length}件` : "必要な場合に追加"}</span>
      </summary>
      {value.map((s, i) => {
        const item = items.find((r) => r.id === s.supplyItemId),
          update = (v: Partial<typeof s>) =>
            onChange(value.map((r, j) => (j === i ? { ...r, ...v } : r)));
        return (
          <div className="commerce-charge-editor" key={i}>
            <div className="commerce-fields">
              <label className="field">
                資材
                <select
                  required
                  value={s.supplyItemId}
                  onChange={(e) => update({ supplyItemId: e.target.value })}
                >
                  <option value="">選択してください</option>
                  {items.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                用途
                <select
                  value={s.purpose}
                  onChange={(e) => update({ purpose: e.target.value as typeof s.purpose })}
                >
                  <option value="PACKING">梱包用</option>
                  <option value="COMPONENT">商品構成用</option>
                </select>
              </label>
              <label className="field">
                1販売単位あたりの使用量
                <input
                  required
                  inputMode="decimal"
                  value={s.quantity}
                  onChange={(e) => update({ quantity: e.target.value })}
                />
              </label>
              <label className="field">
                使用単価（円）
                <input
                  inputMode="decimal"
                  placeholder={
                    item?.unitCost ? `最新購入単価 ¥${item.unitCost}` : "最新購入単価を使用"
                  }
                  value={s.unitCost}
                  onChange={(e) => update({ unitCost: e.target.value })}
                />
              </label>
            </div>
            <button
              className="commerce-text-button"
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              この資材を外す
            </button>
          </div>
        );
      })}
      <button
        className="button secondary"
        type="button"
        onClick={() =>
          onChange([
            ...value,
            { supplyItemId: items[0]?.id || "", purpose: "PACKING", quantity: "1", unitCost: "" },
          ])
        }
      >
        資材を追加
      </button>
    </details>
  );
}
