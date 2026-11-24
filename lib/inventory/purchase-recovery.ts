import { purchaseRecordSchema } from "@/lib/validation/workflow";
import type { PurchaseUiSnapshot } from "@/components/forms/purchase-form";

// Reconstruct editable input only from the authenticated server-side request, not browser storage.
export function purchaseRequestSnapshot(payload: unknown): PurchaseUiSnapshot | undefined {
  const parsed = purchaseRecordSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const input = parsed.data;
  return {
    purchaseId: input.purchaseId,
    baseSnapshot: input.baseSnapshot,
    revision: input.revision,
    date: input.purchasedDate,
    supplierId: input.supplierId,
    locationId: input.storageLocationId,
    orderNumber: input.orderNumber,
    total: input.purchaseTotalJpy,
    memo: input.memo,
    requestKey: input.idempotencyKey,
    products: input.newProducts,
    lines: input.lines,
    step: 3,
  };
}
