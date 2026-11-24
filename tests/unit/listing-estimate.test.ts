import { describe, expect, it } from "vitest";
import { estimateProfit } from "@/lib/sales/listing-estimate";
import { movingAverageOutCost } from "@/lib/inventory/money";
import { settingsReturnPath } from "@/lib/settings/return-path";
describe("listing profit completeness", () => {
  it("allows only a local opaque draft return link", () => {
    const path = "/sales/listings/new?draft=11111111-1111-4111-8111-111111111111";
    expect(settingsReturnPath(path)).toBe(path);
    expect(settingsReturnPath("https://example.com/")).toBe(null);
    expect(settingsReturnPath("//example.com/")).toBe(null);
    expect(settingsReturnPath("/purchases/new?payload=private")).toBe(null);
    for (const base of ["/sales/new", "/sales/batch", "/purchases/new"]) {
      const draft = `${base}?draft=11111111-1111-4111-8111-111111111111`;
      expect(settingsReturnPath(draft)).toBe(draft);
      expect(settingsReturnPath(`${draft}&next=https://example.com`)).toBe(null);
    }
  });
  it("does not replace unknown expenses or cost with zero", () => {
    expect(
      estimateProfit({ price: 980n, cost: 100n, fee: 98n, shipping: null, packing: 0n, other: 0n }),
    ).toEqual({ missing: ["見込み送料"], profit: null });
  });
  it("accepts explicit zero and the full common rounded component cost", () => {
    const cost = movingAverageOutCost(1000n, 3, 3);
    expect(cost).toBe(1000n);
    expect(
      estimateProfit({ price: 1280n, cost, fee: 128n, shipping: 0n, packing: 0n, other: 0n }),
    ).toEqual({ missing: [], profit: 152n });
  });
});
