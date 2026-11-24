import { expect, it } from "vitest";
import { allocateReturnedComponents } from "@/lib/sales/return-allocation";
it("allocates partial returns across lots without rounding away components", () => {
  const rows = ["a", "b"].map((id) => ({
    id,
    itemVariantId: "v",
    uniqueStockUnitId: null,
    quantity: 1,
    dispositions: [] as { quantity: number }[],
  }));
  expect([...allocateReturnedComponents(rows, 2, 0, 1).values()]).toEqual([1, 0]);
  rows[0]!.dispositions.push({ quantity: 1 });
  expect([...allocateReturnedComponents(rows, 2, 1, 1).values()]).toEqual([0, 1]);
});
