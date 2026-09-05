"use client";

import { useActionState } from "react";
import {
  createStorageLocationAction,
  createSupplierAction,
  type InventoryActionState,
} from "@/app/inventory/actions";

const initial: InventoryActionState = {};

function Message({ state }: { state: InventoryActionState }) {
  if (!state.error && !state.success) return null;
  return (
    <p className={`message ${state.error ? "error" : "success"}`} role="alert">
      {state.error ?? state.success}
    </p>
  );
}

export function StorageLocationForm({ businessUnitId }: { businessUnitId: string }) {
  const [state, action, pending] = useActionState(createStorageLocationAction, initial);
  return (
    <form action={action} className="stack">
      <Message state={state} />
      <label className="field">
        <span>保管場所コード</span>
        <input name="code" required pattern="[A-Za-z0-9_-]+" maxLength={40} placeholder="HOME" />
      </label>
      <label className="field">
        <span>保管場所名</span>
        <input name="name" required maxLength={80} placeholder="自宅・棚A" />
      </label>
      <label className="field">
        <span>利用範囲</span>
        <select name="businessUnitId" defaultValue={businessUnitId}>
          <option value="">全部門で共通</option>
          <option value={businessUnitId}>現在の販売部門のみ</option>
        </select>
      </label>
      <button className="button" disabled={pending}>
        {pending ? "登録中…" : "保管場所を登録"}
      </button>
    </form>
  );
}

export function SupplierForm() {
  const [state, action, pending] = useActionState(createSupplierAction, initial);
  return (
    <form action={action} className="stack">
      <Message state={state} />
      <label className="field">
        <span>仕入先名</span>
        <input name="name" required maxLength={120} />
      </label>
      <label className="field">
        <span>メモ</span>
        <textarea name="memo" maxLength={1000} />
      </label>
      <button className="button" disabled={pending}>
        {pending ? "登録中…" : "仕入先を登録"}
      </button>
    </form>
  );
}
