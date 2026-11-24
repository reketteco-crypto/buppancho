import { describe, expect, it } from "vitest";
import {
  assertFixedStocktakes,
  bookQuantityAt,
  type CountEvent,
  type FixedCount,
} from "@/lib/inventory/stocktake-ledger";
const event = (
  id: string,
  date: string,
  quantity: number,
  order = "1",
  from: string | null = null,
  to: string | null = "A",
): CountEvent => ({
  id,
  date,
  order,
  movements: [
    {
      itemVariantId: "v",
      uniqueStockUnitId: null,
      movementType: quantity < 0 ? "ADJUSTMENT_OUT" : "ADJUSTMENT_IN",
      quantity,
      storageLocationFromId: from,
      storageLocationToId: to,
    },
  ],
});
const receipt = event("receipt", "2026-01-01", 10);
const count = event("count", "2026-02-01", -1, "2", "A", null);
const observation: FixedCount = {
  operationId: "count",
  itemVariantId: "v",
  storageLocationId: "A",
  bookQuantity: 10,
  countedQuantity: 9,
  difference: -1,
};
describe("fixed location measurements", () => {
  it("counts at the observed date, not from the current balance", () => {
    expect(
      bookQuantityAt([receipt, event("later", "2026-03-01", 10)], "v", "A", "2026-02-01"),
    ).toBe(10);
  });
  it("uses reviewed same-day order without inventing a time", () => {
    const later = event("later", "2026-01-01", 3, "2");
    expect(bookQuantityAt([receipt, later], "v", "A", "2026-01-01", "later")).toBe(10);
    expect(bookQuantityAt([receipt, later], "v", "A", "2026-01-01")).toBe(13);
    expect(() => bookQuantityAt([receipt], "v", "A", "2026-01-01", "missing")).toThrow();
  });
  it("separates locations, individuals and non-saleable returns", () => {
    const transfer = event("transfer", "2026-01-02", 2, "2", "A", "B");
    transfer.movements[0]!.movementType = "LOCATION_TRANSFER";
    const defective = event("bad", "2026-01-03", 4);
    defective.movements[0]!.movementType = "RETURN_DEFECTIVE";
    const unique = event("unique", "2026-01-03", 1);
    unique.movements[0]!.uniqueStockUnitId = "u";
    expect(bookQuantityAt([receipt, transfer, defective, unique], "v", "A", "2026-02-01")).toBe(8);
    expect(bookQuantityAt([receipt, transfer], "v", "B", "2026-02-01")).toBe(2);
  });
  it("preserves the fixed adjustment after later events", () => {
    expect(() =>
      assertFixedStocktakes([receipt, count, event("later", "2026-03-01", 4)], [observation]),
    ).not.toThrow();
  });
  it.each([1, -1])("rejects a backdated quantity change %s before an observation", (quantity) => {
    const prior = event(
      "prior",
      "2026-01-02",
      quantity,
      "3",
      quantity < 0 ? "A" : null,
      quantity > 0 ? "A" : null,
    );
    expect(() => assertFixedStocktakes([receipt, prior, count], [observation])).toThrow(/実測記録/);
  });
  it("keeps a zero-difference observation without a fictional movement", () => {
    const zero = { ...count, movements: [] };
    const row = { ...observation, countedQuantity: 10, difference: 0 };
    expect(() => assertFixedStocktakes([receipt, zero], [row])).not.toThrow();
    expect(() => assertFixedStocktakes([receipt], [row])).toThrow();
  });
  it("rejects missing or inconsistent count movements", () => {
    expect(() =>
      assertFixedStocktakes([receipt, { ...count, movements: [] }], [observation]),
    ).toThrow();
    expect(() =>
      assertFixedStocktakes([receipt, count], [{ ...observation, difference: 0 }]),
    ).toThrow();
  });
});
