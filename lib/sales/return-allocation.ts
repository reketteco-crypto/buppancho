// Allocate a returned sale unit across its fixed component consumptions, not independently
// across lots: rounding each lot would lose components on partial returns.
export function allocateReturnedComponents<
  T extends {
    id: string;
    itemVariantId: string;
    uniqueStockUnitId: string | null;
    quantity: number;
    dispositions: { quantity: number }[];
  },
>(rows: T[], sold: number, returned: number, returning: number) {
  const key = (r: T) =>
    r.uniqueStockUnitId ? `unit:${r.uniqueStockUnitId}` : `variant:${r.itemVariantId}`;
  const result = new Map<string, number>();
  for (const groupKey of new Set(rows.map(key))) {
    const group = rows.filter((r) => key(r) === groupKey).sort((a, b) => a.id.localeCompare(b.id));
    const total = group.reduce((sum, r) => sum + r.quantity, 0);
    if (total % sold !== 0)
      throw new Error("販売時の構成数量に不整合があります。返品は保存されていません。");
    let needed =
      (total / sold) * (returned + returning) -
      group.reduce((sum, r) => sum + r.dispositions.reduce((s, d) => s + d.quantity, 0), 0);
    for (const row of group) {
      const available = row.quantity - row.dispositions.reduce((sum, d) => sum + d.quantity, 0);
      const quantity = Math.min(needed, available);
      if (quantity < 0) throw new Error("返品履歴と構成数量が一致しません。");
      result.set(row.id, quantity);
      needed -= quantity;
    }
    if (needed) throw new Error("返品数量が販売時の構成数量を超えています。");
  }
  return result;
}
