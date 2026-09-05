"use client";

import { useActionState, useState } from "react";
import { cancelPurchaseAction, type InventoryActionState } from "@/app/inventory/actions";
import { createClientUuid } from "@/lib/client-uuid";

export function PurchaseCancelForm({ purchaseId }: { purchaseId: string }) {
  const [state, action, pending] = useActionState(cancelPurchaseAction, {} as InventoryActionState);
  const [idempotencyKey] = useState(() => createClientUuid());

  return (
    <form action={action} className="inline-cancel">
      {state.error || state.success ? (
        <p className={`message ${state.error ? "error" : "success"}`} role="alert">
          {state.error ?? state.success}
        </p>
      ) : null}
      <input type="hidden" name="id" value={purchaseId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input name="reason" required maxLength={500} placeholder="取消理由" />
      <button className="button danger" disabled={pending}>
        {pending ? "取消処理中…" : "仕入れを取り消す"}
      </button>
    </form>
  );
}
