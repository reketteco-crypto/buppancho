import { WorkflowError } from "@/lib/sales/workflow-errors";
export type Handling = { quantity: number; disposition: string };
export function returnProgress(quantity: number, rows: Handling[]) {
  const processed = rows.reduce((s, r) => s + r.quantity, 0);
  if (
    !Number.isInteger(quantity) ||
    quantity <= 0 ||
    rows.some(
      (r) =>
        !Number.isInteger(r.quantity) ||
        r.quantity <= 0 ||
        !["RESTOCK", "DEFECTIVE", "DISPOSED", "LOST"].includes(r.disposition),
    ) ||
    processed > quantity
  )
    throw new WorkflowError("VALIDATION", "元の確保数量を超える返送確認はできません。");
  const good = rows.filter((r) => r.disposition === "RESTOCK").reduce((s, r) => s + r.quantity, 0);
  return {
    processed,
    pending: quantity - processed,
    good,
    removed: processed - good,
    allGood: good === quantity,
  };
}
