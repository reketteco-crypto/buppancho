import { movingAverageOutCost } from "@/lib/inventory/money";
import { WorkflowError } from "@/lib/sales/workflow-errors";

export type ValuationRow = {
  id: string;
  kind: string;
  quantity: number;
  cost: bigint;
  consumptionId?: string;
  returnId?: string;
  returnConsumptionId?: string;
  returnConsumptionQuantity?: number;
  mirrorOutId?: string;
};
export type ValuationEvent = { id: string; rows: ValuationRow[]; preserveCosts?: boolean };
export type ReplayedValuation = {
  quantity: number;
  cost: bigint;
  movementCosts: Map<string, bigint>;
  consumptionCosts: Map<string, bigint>;
  dispositionCosts: Map<string, bigint>;
  eventBalances?: Map<
    string,
    { beforeQuantity: number; beforeCost: bigint; quantity: number; cost: bigint }
  >;
};
/** Compare outcomes by identity, not the insertion order of maps produced by replay. */
export function canonicalValuationResults(results: Map<string, ReplayedValuation>) {
  const amounts = (values: Map<string, bigint>) =>
    [...values].sort(([a], [b]) => a.localeCompare(b));
  return [...results]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => ({
      id,
      quantity: value.quantity,
      cost: value.cost,
      movements: amounts(value.movementCosts),
      consumptions: amounts(value.consumptionCosts),
      dispositions: amounts(value.dispositionCosts),
    }));
}
export function replayValuation(
  events: ValuationEvent[],
  captureEvents?: ReadonlySet<string>,
): ReplayedValuation {
  let quantity = 0,
    cost = 0n;
  const movementCosts = new Map<string, bigint>(),
    consumptionCosts = new Map<string, bigint>(),
    dispositionCosts = new Map<string, bigint>();
  const returned = new Map<string, { quantity: number; cost: bigint }>();
  const eventBalances = captureEvents
    ? new Map<
        string,
        { beforeQuantity: number; beforeCost: bigint; quantity: number; cost: bigint }
      >()
    : undefined;
  const fail = () => {
    throw new WorkflowError(
      "HISTORY_INCOMPLETE",
      "過去の在庫数量・原価を照合できません。元の入庫・販売・返品履歴を確認してください。",
    );
  };
  for (const event of events) {
    const beforeQuantity = quantity,
      beforeCost = cost;
    const outgoing = event.rows.filter((r) => r.quantity < 0 && r.kind !== "RECEIPT_REVERSAL");
    const outQty = outgoing.reduce((s, r) => s - r.quantity, 0);
    if (outQty > quantity) fail();
    const outCost = event.preserveCosts
      ? outgoing.reduce((s, r) => s - r.cost, 0n)
      : outQty
        ? movingAverageOutCost(cost, quantity, outQty)
        : 0n;
    let allocated = 0n;
    for (const [index, row] of outgoing.entries()) {
      const amount = event.preserveCosts
        ? -row.cost
        : index === outgoing.length - 1
          ? outCost - allocated
          : (outCost * BigInt(-row.quantity)) / BigInt(outQty);
      allocated += amount;
      movementCosts.set(row.id, -amount);
      if (row.consumptionId) consumptionCosts.set(row.consumptionId, amount);
    }
    quantity -= outQty;
    cost -= outCost;
    for (const row of event.rows) {
      if (outgoing.includes(row)) continue;
      let amount = row.cost;
      if (row.returnId) {
        const id = row.returnConsumptionId!,
          original = consumptionCosts.get(id),
          used = returned.get(id) ?? { quantity: 0, cost: 0n };
        const sold = row.returnConsumptionQuantity!;
        if (original === undefined || !sold || used.quantity + row.quantity > sold) fail();
        amount = event.preserveCosts
          ? row.cost
          : used.quantity + row.quantity === sold
            ? original! - used.cost
            : (original! * BigInt(row.quantity)) / BigInt(sold);
        if (
          amount < 0n ||
          used.cost + amount > original! ||
          (used.quantity + row.quantity === sold && used.cost + amount !== original!)
        )
          fail();
        returned.set(id, { quantity: used.quantity + row.quantity, cost: used.cost + amount });
        dispositionCosts.set(row.returnId, amount);
      } else if (row.mirrorOutId) {
        const mirrored = movementCosts.get(row.mirrorOutId);
        if (mirrored === undefined) fail();
        amount = -mirrored!;
      } else if (
        row.kind === "RETURN_IN" ||
        row.kind === "RETURN_DEFECTIVE" ||
        row.kind === "RETURN_DISPOSAL"
      )
        fail();
      if (row.kind === "LOCATION_TRANSFER") {
        if (row.quantity > quantity) fail();
        amount = event.preserveCosts
          ? row.cost
          : movingAverageOutCost(cost, quantity, row.quantity);
      } else if (!["RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(row.kind)) {
        quantity += row.quantity;
        cost += amount;
      }
      movementCosts.set(row.id, amount);
    }
    if (quantity < 0 || cost < 0n || (quantity === 0 && cost !== 0n)) fail();
    if (captureEvents?.has(event.id))
      eventBalances!.set(event.id, { beforeQuantity, beforeCost, quantity, cost });
  }
  return {
    quantity,
    cost,
    movementCosts,
    consumptionCosts,
    dispositionCosts,
    ...(eventBalances ? { eventBalances } : {}),
  };
}
