import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  componentsSchema,
  confirmedProfit,
  eventDate,
  mercariReference,
  optionalMoney,
} from "@/lib/validation/workflow";
describe("two-record workflow validation", () => {
  it("preserves unknown money independently of an explicit zero", () => {
    expect(optionalMoney.parse("")).toBeNull();
    expect(optionalMoney.parse("0")).toBe(0n);
    expect(optionalMoney.safeParse("1.5").success).toBe(false);
    expect(optionalMoney.safeParse("-1").success).toBe(false);
    expect(
      confirmedProfit({ revenue: 1000n, costs: [100n, null, 0n, 0n], cogs: 200n, finalCost: true }),
    ).toBeNull();
    expect(
      confirmedProfit({ revenue: 1000n, costs: [100n, 0n, 0n, 0n], cogs: 200n, finalCost: true }),
    ).toBe(700n);
    expect(
      confirmedProfit({ revenue: 1000n, costs: [0n], cogs: null, finalCost: true }),
    ).toBeNull();
  });
  it("parses only recognised Mercari references without fetching", () => {
    expect(mercariReference("https://jp.mercari.com/item/m123456789?source=share").id).toBe(
      "m123456789",
    );
    expect(mercariReference("m123456789").url).toBe("https://jp.mercari.com/item/m123456789");
    expect(() => mercariReference("https://jp.mercari.com.evil.example/item/m123456789")).toThrow();
    expect(() => mercariReference("javascript:alert(1)")).toThrow();
  });
  it("rejects nonexistent dates, repeated components and invalid unique quantities", () => {
    expect(eventDate.safeParse("2026-02-29").success).toBe(false);
    const component = { itemVariantId: randomUUID(), uniqueStockUnitId: null, requiredQuantity: 1 };
    expect(componentsSchema.safeParse([component, component]).success).toBe(false);
    expect(
      componentsSchema.safeParse([
        { ...component, itemVariantId: null, uniqueStockUnitId: randomUUID(), requiredQuantity: 2 },
      ]).success,
    ).toBe(false);
  });
});
