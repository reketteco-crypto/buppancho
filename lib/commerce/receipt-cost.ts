/** Registration order is fixed; the final received portion absorbs yen remainders. */
export function receiptCostPlan(
  ordered: number,
  orderCost: bigint,
  receipts: {
    id: string;
    quantity: number;
    deliveryLineId?: string | null;
    links?: { deliveryLineId: string; quantity: number }[];
  }[],
  deliveries: { id: string; quantity: number; cost: bigint }[],
) {
  const result = new Map(receipts.map((r) => [r.id, 0n]));
  function shares(total: bigint, quantity: number, portions: { id: string; quantity: number }[]) {
    let used = 0n,
      count = 0;
    for (const portion of portions) {
      count += portion.quantity;
      if (count > quantity) throw new Error("受取数量が配分対象数を超えています。");
      const cost =
        count === quantity ? total - used : (total * BigInt(portion.quantity)) / BigInt(quantity);
      used += cost;
      result.set(portion.id, result.get(portion.id)! + cost);
    }
  }
  shares(orderCost, ordered, receipts);
  for (const delivery of deliveries)
    shares(
      delivery.cost,
      delivery.quantity,
      receipts.flatMap((r) => {
        const quantity =
          r.deliveryLineId === delivery.id
            ? r.quantity
            : (r.links ?? [])
                .filter((l) => l.deliveryLineId === delivery.id)
                .reduce((s, l) => s + l.quantity, 0);
        return quantity ? [{ id: r.id, quantity }] : [];
      }),
    );
  if ([...result.values()].some((cost) => cost < 0n))
    throw new Error("受取原価が0円を下回ります。");
  return result;
}
