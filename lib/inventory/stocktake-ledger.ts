import Decimal from "decimal.js";
import { WorkflowError } from "@/lib/sales/workflow-errors";

export type CountMovement = {
  itemVariantId: string;
  uniqueStockUnitId: string | null;
  movementType: string;
  quantity: number;
  storageLocationFromId: string | null;
  storageLocationToId: string | null;
};
export type CountEvent = { id: string; date: string; order: string; movements: CountMovement[] };
export type FixedCount = {
  operationId: string;
  itemVariantId: string;
  storageLocationId: string;
  bookQuantity: number;
  countedQuantity: number;
  difference: number;
};
const precise = Decimal.clone({ precision: 80 });
const keyFor = (variant: string, location: string) => `${variant}:${location}`;
export function sortedCountEvents(events: CountEvent[]) {
  return [...events].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      new precise(a.order).comparedTo(b.order) ||
      a.id.localeCompare(b.id),
  );
}
function apply(counts: Map<string, number>, movement: CountMovement) {
  if (
    movement.uniqueStockUnitId ||
    ["RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(movement.movementType)
  )
    return;
  const change = (location: string | null, q: number) => {
    if (location) {
      const key = keyFor(movement.itemVariantId, location);
      counts.set(key, (counts.get(key) ?? 0) + q);
    }
  };
  if (movement.movementType === "LOCATION_TRANSFER") {
    change(movement.storageLocationFromId, -movement.quantity);
    change(movement.storageLocationToId, movement.quantity);
  } else if (movement.quantity < 0) change(movement.storageLocationFromId, movement.quantity);
  else change(movement.storageLocationToId, movement.quantity);
}
/** Location total immediately before a proposed event, never the current cached quantity. */
export function bookQuantityAt(
  events: CountEvent[],
  variant: string,
  location: string,
  date: string,
  position = "LAST",
  plannedOrder?: string,
) {
  const counts = new Map<string, number>();
  const before =
    position === "LAST" ? undefined : events.find((e) => e.id === position && e.date === date);
  if (position !== "LAST" && !before)
    throw new WorkflowError("CONFLICT", "同日の記録が変わりました。順序を選び直してください。");
  const boundary = plannedOrder ?? before?.order;
  for (const event of sortedCountEvents(events)) {
    if (
      event.date > date ||
      (event.date === date &&
        boundary !== undefined &&
        new precise(event.order).greaterThanOrEqualTo(boundary))
    )
      continue;
    for (const movement of event.movements) apply(counts, movement);
  }
  const quantity = counts.get(keyFor(variant, location)) ?? 0;
  if (quantity < 0)
    throw new WorkflowError(
      "HISTORY_INCOMPLETE",
      "数えた時点の保管場所で在庫が負数です。元の履歴を確認してください。",
    );
  return quantity;
}
/** Measurements and their fixed adjustment must remain true after every subsequent backdated write. */
export function assertFixedStocktakes(events: CountEvent[], observations: FixedCount[]) {
  if (!observations.length) return;
  const counts = new Map<string, number>();
  const visited = new Set<string>();
  for (const event of sortedCountEvents(events)) {
    const rows = observations.filter((o) => o.operationId === event.id);
    for (const row of rows) {
      if ((counts.get(keyFor(row.itemVariantId, row.storageLocationId)) ?? 0) !== row.bookQuantity)
        throw new WorkflowError(
          "HISTORY_INCOMPLETE",
          `${event.date}の実測記録と訂正前の帳簿数が矛盾します。実測値や調整数量は自動で変更しません。`,
        );
    }
    for (const movement of event.movements) apply(counts, movement);
    for (const row of rows) {
      if (
        row.difference !== row.countedQuantity - row.bookQuantity ||
        (counts.get(keyFor(row.itemVariantId, row.storageLocationId)) ?? 0) !== row.countedQuantity
      )
        throw new WorkflowError(
          "HISTORY_INCOMPLETE",
          `${event.date}の実測数量と在庫履歴が一致しません。元の実測記録を確認してください。`,
        );
      visited.add(row.operationId);
    }
  }
  if (observations.some((o) => !visited.has(o.operationId)))
    throw new WorkflowError("HISTORY_INCOMPLETE", "実測記録に対応する在庫操作がありません。");
}
