import { describe, it, expect } from "vitest";
import { businessReport } from "@/lib/commerce/reports";

describe("返品・返金の元販売月への集計", () => {
  it("月跨ぎの返金・返還・良品戻しを有効完了月へ反映し、返品月へ重複させない", async () => {
    const c = { workspaceId: "workspace", businessUnitId: "unit", reportingEntityId: "entity" };
    const empty = { findMany: async () => [] };
    const db = {
      salesOrder: {
        findMany: async () => [
          {
            id: "sale",
            completedAt: new Date("2026-01-10T00:00:00+09:00"),
            grossSalesJpy: 500n,
            discountJpy: 0n,
            feeJpy: 50n,
            shippingJpy: 100n,
            packingJpy: 0n,
            otherCostJpy: 0n,
            costStatus: "FINAL",
            lines: [{ managementCogsJpy: 100n }],
          },
        ],
      },
      salesReturn: {
        findMany: async () => [
          {
            id: "refund",
            salesOrderId: "sale",
            returnedAt: new Date("2026-03-10T00:00:00+09:00"),
            salesRefundJpy: 200n,
            feeRefundJpy: 20n,
            shippingRefundJpy: 10n,
            lines: [
              { dispositions: [{ id: "restock", disposition: "RESTOCK", costTotalJpy: 40n }] },
            ],
          },
        ],
      },
      inventoryOperation: {
        findMany: async ({ where }: { where: { sourceType?: string } }) =>
          where.sourceType === "sales_order"
            ? [{ id: "op", sourceId: "sale", occurredAt: new Date("2026-01-10T00:00:00+09:00") }]
            : [],
      },
      eventDateCorrection: {
        findMany: async () => [
          { operationId: "op", effectiveDate: new Date("2026-02-10"), valuationOrder: null },
        ],
      },
      valuationAdjustment: { findMany: async () => [{ targetId: "restock", afterJpy: 50n }] },
      purchaseDocument: empty,
      purchaseCharge: empty,
      otherRecord: empty,
      stockMovement: empty,
      supplierReturn: empty,
      moneyTransaction: empty,
      workflowEvent: empty,
      receiptCostCorrection: empty,
    } as unknown as Parameters<typeof businessReport>[0];
    const january = await businessReport(db, c, "2026-01-01", "2026-01-31");
    const february = await businessReport(db, c, "2026-02-01", "2026-02-28");
    const march = await businessReport(db, c, "2026-03-01", "2026-03-31");
    expect(january.revenue).toBe(0n);
    expect(february).toMatchObject({ revenue: 300n, salesExpenses: 120n, cogs: 50n, profit: 130n });
    expect(march).toMatchObject({ revenue: 0n, salesExpenses: 0n, cogs: 0n, profit: 0n });
  });
});
