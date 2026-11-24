import { describe, it, expect } from "vitest";
import {
  canonicalValuationResults,
  replayValuation,
  type ValuationRow,
} from "@/lib/inventory/valuation-engine";
const event = (id: string, quantity: number, cost: bigint, extra: Partial<ValuationRow> = {}) => ({
  id,
  rows: [{ id, kind: quantity > 0 ? "PURCHASE_RECEIPT" : "SALE_OUT", quantity, cost, ...extra }],
});
describe("chronological management valuation", () => {
  it("does not confuse map iteration order with a change in valuation", () => {
    const a = replayValuation([event("a", 1, 100n), event("b", 1, 200n)]);
    const b = replayValuation([event("b", 1, 200n), event("a", 1, 100n)]);
    expect([...a.movementCosts]).not.toEqual([...b.movementCosts]);
    expect(canonicalValuationResults(new Map([["variant", a]]))).toEqual(
      canonicalValuationResults(new Map([["variant", b]])),
    );
  });
  it("still distinguishes a real same-day sale cost change", () => {
    const a = replayValuation([event("a", 1, 100n), event("sale", -1, 0n), event("b", 1, 200n)]);
    const b = replayValuation([event("a", 1, 100n), event("b", 1, 200n), event("sale", -1, 0n)]);
    expect(canonicalValuationResults(new Map([["variant", a]]))).not.toEqual(
      canonicalValuationResults(new Map([["variant", b]])),
    );
  });
  it("uses the cost at completion, not the current average", () => {
    const result = replayValuation([
      event("a", 10, 1000n),
      event("sale", -1, 0n, { consumptionId: "c" }),
      event("b", 10, 2000n),
    ]);
    expect(result.consumptionCosts.get("c")).toBe(100n);
    expect(result.quantity).toBe(19);
    expect(result.cost).toBe(2900n);
  });
  it("captures the balance immediately around a receipt, before later purchases", () => {
    const result = replayValuation(
      [event("old", 10, 1000n), event("pending", 5, 800n), event("later", 5, 1000n)],
      new Set(["pending"]),
    );
    expect(result.eventBalances?.get("pending")).toEqual({
      beforeQuantity: 10,
      beforeCost: 1000n,
      quantity: 15,
      cost: 1800n,
    });
    expect(result.cost).toBe(2800n);
    expect(result.eventBalances?.size).toBe(1);
  });
  it("revalues a later sale without adding quantity movements", () => {
    const events = [
      event("a", 10, 1000n),
      event("late", -1, 0n),
      event("b", 10, 2000n),
      event("sale", -1, -150n, { consumptionId: "c" }),
    ];
    const r = replayValuation(events);
    expect(r.consumptionCosts.get("c")).toBe(153n);
    expect(r.quantity).toBe(18);
    expect(r.cost).toBe(2747n);
    expect(events).toHaveLength(4);
  });
  it("restock, defective and discarded returns inherit corrected sold cost with deterministic remainder", () => {
    const r = replayValuation([
      event("in", 4, 401n),
      event("sale", -3, -300n, { consumptionId: "c" }),
      event("good", 1, 100n, {
        kind: "RETURN_IN",
        returnId: "r1",
        returnConsumptionId: "c",
        returnConsumptionQuantity: 3,
      }),
      event("bad", 1, 100n, {
        kind: "RETURN_DEFECTIVE",
        returnId: "r2",
        returnConsumptionId: "c",
        returnConsumptionQuantity: 3,
      }),
      event("discard", 1, 100n, {
        kind: "RETURN_DISPOSAL",
        returnId: "r3",
        returnConsumptionId: "c",
        returnConsumptionQuantity: 3,
      }),
    ]);
    expect(r.consumptionCosts.get("c")).toBe(301n);
    expect([...r.dispositionCosts.values()]).toEqual([100n, 100n, 101n]);
    expect(r.quantity).toBe(2);
    expect(r.cost).toBe(200n);
  });
  it("location transfer does not alter departmental cost or quantity", () => {
    const r = replayValuation([
      event("in", 3, 100n),
      event("move", 2, 0n, { kind: "LOCATION_TRANSFER" }),
    ]);
    expect(r.quantity).toBe(3);
    expect(r.cost).toBe(100n);
    expect(r.movementCosts.get("move")).toBe(67n);
  });
  it("rejects missing history, negative prefixes and over-return", () => {
    expect(() => replayValuation([event("sale", -1, 0n), event("in", 2, 200n)])).toThrow();
    expect(() => replayValuation([event("return", 1, 0n, { kind: "RETURN_IN" })])).toThrow();
    expect(() =>
      replayValuation([
        event("in", 1, 100n),
        event("sale", -1, -100n, { consumptionId: "c" }),
        event("return", 2, 200n, {
          kind: "RETURN_IN",
          returnId: "r",
          returnConsumptionId: "c",
          returnConsumptionQuantity: 1,
        }),
      ]),
    ).toThrow();
  });
  it("keeps effective prior allocations and transfer rounding before the insertion point", () => {
    const r = replayValuation([
      event("in", 4, 401n),
      { ...event("sale", -3, -300n, { consumptionId: "c" }), preserveCosts: true },
      {
        ...event("return", 1, 101n, {
          kind: "RETURN_IN",
          returnId: "r",
          returnConsumptionId: "c",
          returnConsumptionQuantity: 3,
        }),
        preserveCosts: true,
      },
      { ...event("move", 1, 100n, { kind: "LOCATION_TRANSFER" }), preserveCosts: true },
      event("pending", -1, 0n, { consumptionId: "new" }),
    ]);
    expect(r.consumptionCosts.get("c")).toBe(300n);
    expect(r.dispositionCosts.get("r")).toBe(101n);
    expect(r.movementCosts.get("move")).toBe(100n);
    expect(r.consumptionCosts.get("new")).toBe(101n);
    expect(r.cost).toBe(101n);
  });
});
