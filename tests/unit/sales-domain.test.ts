import { describe, expect, it } from "vitest";
import {
  canChangeListingStatus,
  listingAvailability,
  skuAvailability,
} from "@/lib/sales/availability";
import { estimatedFee, managementProfit, parsePercent } from "@/lib/sales/money";
import { returnSchema, salesSkuSchema } from "@/lib/validation/sales";

describe("sales availability", () => {
  it("calculates bundle availability from its limiting component", () => {
    expect(
      skuAvailability([
        { availableQuantity: 10, requiredQuantity: 1 },
        { availableQuantity: 15, requiredQuantity: 2 },
        { availableQuantity: 100, requiredQuantity: 1 },
      ]),
    ).toBe(7);
  });

  it("limits listing availability by both listing and stock", () => {
    expect(listingAvailability(10, 2, 5)).toBe(5);
    expect(listingAvailability(3, 2, 10)).toBe(1);
  });

  it("accepts only declared listing transitions", () => {
    expect(canChangeListingStatus("ACTIVE", "PAUSED")).toBe(true);
    expect(canChangeListingStatus("ENDED", "ACTIVE")).toBe(false);
  });
});

describe("sales money", () => {
  it("converts a user percentage without floating point numbers", () => {
    expect(parsePercent("10")).toBe("0.100000");
    expect(estimatedFee(980n, "0.100000")).toBe(98n);
    expect(() => parsePercent("100.01")).toThrow();
  });

  it("calculates profit and return adjustments in integer yen", () => {
    expect(managementProfit({ gross: 10_000n, fee: 1_000n, shipping: 750n, cogs: 3_000n })).toBe(
      5_250n,
    );
    expect(
      managementProfit({
        gross: 10_000n,
        fee: 1_000n,
        shipping: 750n,
        cogs: 3_000n,
        salesRefund: 5_000n,
        feeRefund: 500n,
        restockedCost: 1_500n,
      }),
    ).toBe(2_250n);
  });
});

describe("sales SKU validation", () => {
  const base = {
    name: "セット",
    skuType: "BUNDLE",
    description: "",
    expectedPriceJpy: "",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
  } as const;
  it("rejects duplicate components", () => {
    expect(() =>
      salesSkuSchema.parse({
        ...base,
        components: [
          {
            itemVariantId: "00000000-0000-4000-8000-000000000002",
            uniqueStockUnitId: "",
            requiredQuantity: 1,
          },
          {
            itemVariantId: "00000000-0000-4000-8000-000000000002",
            uniqueStockUnitId: "",
            requiredQuantity: 2,
          },
        ],
      }),
    ).toThrow();
  });
  it("requires unique-stock components to have quantity one", () => {
    expect(() =>
      salesSkuSchema.parse({
        ...base,
        components: [
          {
            itemVariantId: "",
            uniqueStockUnitId: "00000000-0000-4000-8000-000000000003",
            requiredQuantity: 2,
          },
        ],
      }),
    ).toThrow();
  });
});

describe("sales return validation", () => {
  const base = {
    orderId: "00000000-0000-4000-8000-000000000001",
    lineId: "00000000-0000-4000-8000-000000000002",
    quantity: 1,
    returnedAt: "2026-09-06T12:00",
    salesRefundJpy: "0",
    feeRefundJpy: "0",
    shippingRefundJpy: "0",
    memo: "",
    idempotencyKey: "00000000-0000-4000-8000-000000000003",
  };

  it("accepts a different disposition for each bundle component", () => {
    expect(
      returnSchema.parse({
        ...base,
        dispositions: [
          {
            itemVariantId: "00000000-0000-4000-8000-000000000004",
            uniqueStockUnitId: null,
            disposition: "RESTOCK",
          },
          {
            itemVariantId: "00000000-0000-4000-8000-000000000005",
            uniqueStockUnitId: null,
            disposition: "DISPOSED",
          },
        ],
      }).dispositions,
    ).toHaveLength(2);
  });

  it("rejects duplicate component dispositions", () => {
    expect(() =>
      returnSchema.parse({
        ...base,
        dispositions: [
          {
            itemVariantId: "00000000-0000-4000-8000-000000000004",
            uniqueStockUnitId: null,
            disposition: "RESTOCK",
          },
          {
            itemVariantId: "00000000-0000-4000-8000-000000000004",
            uniqueStockUnitId: null,
            disposition: "DEFECTIVE",
          },
        ],
      }),
    ).toThrow();
  });
});
