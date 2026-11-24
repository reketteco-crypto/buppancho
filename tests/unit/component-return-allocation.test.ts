import { describe, expect, it } from "vitest";
import { allocateComponentReturn } from "@/lib/sales/component-return-allocation";

const row = {
  id: "a",
  itemVariantId: "v",
  uniqueStockUnitId: null,
  quantity: 3,
  cost: 100n,
  processed: 0,
  processedCost: 0n,
};
describe("component return quantities and original cost", () => {
  it("splits good, defective and disposed with a deterministic last-yen remainder", () => {
    const allocations = allocateComponentReturn(
      [row],
      [
        { key: "v", disposition: "DISPOSED", quantity: "1" },
        { key: "v", disposition: "RESTOCK", quantity: "1" },
        { key: "v", disposition: "DEFECTIVE", quantity: "1" },
      ],
    );
    expect(
      allocations.map(({ quantity, cost, disposition }) => ({ quantity, cost, disposition })),
    ).toEqual([
      { quantity: 1, cost: 33n, disposition: "RESTOCK" },
      { quantity: 1, cost: 33n, disposition: "DEFECTIVE" },
      { quantity: 1, cost: 34n, disposition: "DISPOSED" },
    ]);
  });
  it("inherits corrected original and processed costs across separate returns", () => {
    const [last] = allocateComponentReturn(
      [{ ...row, cost: 101n, processed: 2, processedCost: 66n }],
      [{ key: "v", disposition: "RESTOCK", quantity: "1" }],
    );
    expect(last!.cost).toBe(35n);
  });
  it("rejects over-return, duplicate dispositions, unknown components and fractional quantities", () => {
    for (const requests of [
      [{ key: "v", disposition: "RESTOCK" as const, quantity: "4" }],
      [{ key: "other", disposition: "RESTOCK" as const, quantity: "1" }],
      [{ key: "v", disposition: "RESTOCK" as const, quantity: "0.5" }],
      [
        { key: "v", disposition: "RESTOCK" as const, quantity: "1" },
        { key: "v", disposition: "RESTOCK" as const, quantity: "1" },
      ],
    ])
      expect(() => allocateComponentReturn([row], requests)).toThrow();
  });
  it("cannot return the same unique item in two dispositions", () => {
    expect(() =>
      allocateComponentReturn(
        [{ ...row, quantity: 1, uniqueStockUnitId: "u" }],
        [
          { key: "u", disposition: "RESTOCK", quantity: "1" },
          { key: "u", disposition: "DEFECTIVE", quantity: "1" },
        ],
      ),
    ).toThrow();
  });
});
