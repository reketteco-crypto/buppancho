"use client";

import { useActionState, useState } from "react";
import {
  executeInventoryOperationAction,
  type InventoryActionState,
} from "@/app/inventory/actions";
import { createClientUuid } from "@/lib/client-uuid";

type Variant = { key: string; id: string; label: string; trackingMode: "QUANTITY" | "UNIQUE" };
type Unit = { id: string; variantId: string; label: string; locationId: string };

export function InventoryOperationForm(props: {
  variants: Variant[];
  units: Unit[];
  locations: Array<{ id: string; name: string }>;
  today: string;
}) {
  const [state, action, pending] = useActionState(
    executeInventoryOperationAction,
    {} as InventoryActionState,
  );
  const [operationType, setOperationType] = useState("LOCATION_TRANSFER");
  const [variantKey, setVariantKey] = useState(props.variants[0]?.key ?? "");
  const selected = props.variants.find((item) => item.key === variantKey);
  const variantId = selected?.id ?? "";
  const availableUnits = props.units.filter((item) => item.variantId === variantId);
  const [unitId, setUnitId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [date, setDate] = useState(props.today);
  const [unitCost, setUnitCost] = useState("");
  const [reason, setReason] = useState("数え間違い");
  const [note, setNote] = useState("");
  const [key, setKey] = useState(() => createClientUuid());
  const payload = {
    operationType,
    variantId,
    uniqueStockUnitId: unitId,
    trackingMode: selected?.trackingMode ?? "QUANTITY",
    quantity: selected?.trackingMode === "UNIQUE" ? 1 : quantity,
    fromLocationId: from,
    toLocationId: to,
    occurredDate: date,
    unitCostJpy: unitCost,
    reason,
    note,
    idempotencyKey: key,
  };
  return (
    <form
      action={async (formData) => {
        await action(formData);
        setKey(createClientUuid());
      }}
      className="stack"
    >
      {state.error || state.success ? (
        <p className={`message ${state.error ? "error" : "success"}`} role="alert">
          {state.error ?? state.success}
        </p>
      ) : null}
      <div className="form-grid">
        <label className="field">
          <span>操作</span>
          <select value={operationType} onChange={(e) => setOperationType(e.target.value)}>
            <option value="LOCATION_TRANSFER">保管場所移動</option>
            <option value="DISPOSAL">廃棄</option>
            <option value="LOSS">紛失</option>
            <option value="PERSONAL_USE">私用</option>
            <option value="ADJUSTMENT_IN">在庫増加</option>
            <option value="ADJUSTMENT_OUT">在庫減少</option>
          </select>
        </label>
        <label className="field" htmlFor="inventory-operation-variant">
          <span>商品</span>
          <select
            id="inventory-operation-variant"
            value={variantKey}
            onChange={(e) => {
              setVariantKey(e.target.value);
              setUnitId("");
            }}
            required
          >
            {props.variants.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {selected?.trackingMode === "UNIQUE" ? (
          <label className="field">
            <span>個体</span>
            <select
              value={unitId}
              onChange={(e) => {
                setUnitId(e.target.value);
                setFrom(
                  availableUnits.find((item) => item.id === e.target.value)?.locationId ?? "",
                );
              }}
              required
            >
              <option value="">選択してください</option>
              {availableUnits.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="field">
            <span>数量</span>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              required
            />
          </label>
        )}
        {operationType !== "ADJUSTMENT_IN" ? (
          <label className="field">
            <span>移動元</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)} required>
              <option value="">選択してください</option>
              {props.locations.map((item) => (
                <option key={item.id} value={item.id} disabled={item.id === to}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {operationType === "LOCATION_TRANSFER" || operationType === "ADJUSTMENT_IN" ? (
          <label className="field">
            <span>移動先</span>
            <select value={to} onChange={(e) => setTo(e.target.value)} required>
              <option value="">選択してください</option>
              {props.locations.map((item) => (
                <option key={item.id} value={item.id} disabled={item.id === from}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {operationType === "ADJUSTMENT_IN" ? (
          <label className="field">
            <span>1個原価（円）</span>
            <input
              inputMode="numeric"
              pattern="[0-9]+"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              required
            />
          </label>
        ) : null}
        <label className="field">
          <span>実施日</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="field">
          <span>理由</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {["入力漏れ", "紛失", "破損", "廃棄", "私用", "数え間違い", "その他"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>説明{reason === "その他" ? "（必須）" : ""}</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          required={reason === "その他"}
          maxLength={1000}
        />
      </label>
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <button className="button" disabled={pending || !variantId}>
        {pending ? "記録中…" : "在庫操作を記録"}
      </button>
    </form>
  );
}
