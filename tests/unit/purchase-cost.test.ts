import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buySchema } from "@/lib/commerce/input";
import { calculatePurchase } from "@/lib/commerce/purchase-calculation";
import { purchaseUnitCostLabel, purchaseCostRows } from "@/lib/commerce/purchase-cost";

describe("購入原価の表示", () => {
  it.each([
    ["0", 1, "¥0"],
    ["800", 5, "¥160"],
    ["1000", 3, "約¥333.33"],
    ["1", 4, "¥0.25"],
    ["1", 8, "約¥0.13"],
    ["999999999999999", 1, "¥999,999,999,999,999"],
  ])("原価%s円・%s個の表示は%s", (cost, quantity, label) => {
    expect(purchaseUnitCostLabel(cost, quantity)).toBe(label);
  });
  it("費用配分後の原価を使い、備品と個体を一覧に含めない", () => {
    const clientId = randomUUID();
    const input = buySchema.parse({
      idempotencyKey: randomUUID(),
      draftId: randomUUID(),
      context: { businessUnitId: randomUUID(), operatorId: randomUUID(), year: 2026 },
      date: "2026-11-15",
      supplierName: "取引先",
      locationId: randomUUID(),
      received: false,
      lines: [
        { clientId, name: "商品", quantity: 5, amount: "100", trackingMode: "QUANTITY" },
        {
          clientId: randomUUID(),
          name: "備品",
          quantity: 1,
          amount: "100",
          trackingMode: "QUANTITY",
          purpose: "EQUIPMENT",
        },
        {
          clientId: randomUUID(),
          name: "個体",
          quantity: 1,
          amount: "100",
          trackingMode: "UNIQUE",
        },
      ],
      charges: [
        { name: "送料", amount: "300", lineIds: [clientId] },
        { name: "別経費", amount: "50", capitalized: false },
      ],
    });
    const totals = calculatePurchase(input);
    const balances = [
      {
        variantId: clientId,
        beforeQuantity: 10,
        beforeCost: "1000",
        quantity: 15,
        cost: "1800",
        provisional: false,
      },
    ];
    expect(purchaseCostRows(input, totals, balances)).toMatchObject([
      {
        quantity: 5,
        cost: "800",
        unitCost: "160.000000",
        before: { unitCost: "100.000000" },
        after: { unitCost: "120.000000" },
      },
    ]);
    expect(() => purchaseCostRows(input, { ...totals, final: false }, balances)).toThrow("配分");
    expect(() => purchaseCostRows(input, totals, [])).toThrow("在庫原価");
  });
});
