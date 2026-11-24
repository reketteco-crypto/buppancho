export type ComponentReturnDisposition = "RESTOCK" | "DEFECTIVE" | "DISPOSED";
export type ComponentReturnRequest = {
  key: string;
  disposition: ComponentReturnDisposition;
  quantity: string;
};

/** Preserve old event order; new split returns use the same order during valuation replay. */
export function orderedReturnMovements<T extends { idempotencyKey: string; sourceType: string }>(
  rows: T[],
): T[] {
  const rank = { RESTOCK: "0", DEFECTIVE: "1", DISPOSED: "2" };
  const key = (r: T) =>
    r.idempotencyKey.replace(
      /:(RESTOCK|DEFECTIVE|DISPOSED)$/,
      (_, d: keyof typeof rank) => `:${rank[d]}`,
    );
  return rows.some(
    (r) =>
      r.sourceType === "sales_return" && /:(RESTOCK|DEFECTIVE|DISPOSED)$/.test(r.idempotencyKey),
  )
    ? [...rows].sort((a, b) => key(a).localeCompare(key(b)))
    : rows;
}

/** Allocate only original consumptions. The last portion absorbs the original cost remainder. */
export function allocateComponentReturn<
  T extends {
    id: string;
    itemVariantId: string;
    uniqueStockUnitId: string | null;
    quantity: number;
    cost: bigint;
    processed: number;
    processedCost: bigint;
  },
>(rows: T[], requests: ComponentReturnRequest[]) {
  const result: {
    row: T;
    quantity: number;
    cost: bigint;
    disposition: ComponentReturnDisposition;
  }[] = [];
  const seen = new Set<string>();
  const used = new Map(rows.map((r) => [r.id, { quantity: r.processed, cost: r.processedCost }]));
  // Stable request order also defines the remainder recipient within one submission.
  const order = { RESTOCK: 0, DEFECTIVE: 1, DISPOSED: 2 };
  for (const request of [...requests].sort(
    (a, b) => a.key.localeCompare(b.key) || order[a.disposition] - order[b.disposition],
  )) {
    const identity = `${request.key}:${request.disposition}`;
    if (seen.has(identity)) throw new Error("同じ構成品・処理の重複指定はできません。");
    seen.add(identity);
    if (!/^(0|[1-9]\d{0,5})$/.test(request.quantity))
      throw new Error("構成品の数量を0以上の整数で入力してください。");
    let needed = Number(request.quantity);
    const group = rows
      .filter((r) => (r.uniqueStockUnitId ?? r.itemVariantId) === request.key)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!group.length) throw new Error("販売時の構成に含まれない商品です。");
    for (const row of group) {
      const prior = used.get(row.id)!;
      if (
        prior.quantity < 0 ||
        prior.quantity > row.quantity ||
        prior.cost < 0n ||
        prior.cost > row.cost
      )
        throw new Error("元の販売数量・原価と返品履歴が一致しません。");
      const quantity = Math.min(needed, row.quantity - prior.quantity);
      if (!quantity) continue;
      const cost =
        quantity === row.quantity - prior.quantity
          ? row.cost - prior.cost
          : (row.cost * BigInt(quantity)) / BigInt(row.quantity);
      if (cost < 0n || prior.cost + cost > row.cost)
        throw new Error("返品原価が元の販売原価を超えています。");
      result.push({ row, quantity, cost, disposition: request.disposition });
      used.set(row.id, { quantity: prior.quantity + quantity, cost: prior.cost + cost });
      needed -= quantity;
    }
    if (needed) throw new Error("構成品の返品数量が残りの販売数量を超えています。");
  }
  if (!result.length) throw new Error("返品する構成品の数量を1つ以上入力してください。");
  return result;
}
