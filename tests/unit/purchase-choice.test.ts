import { describe, expect, it } from "vitest";
import { applyPurchaseChoice, type PurchaseChoice } from "@/lib/commerce/purchase-choice";
import { buySchema } from "@/lib/commerce/input";
import { randomUUID } from "node:crypto";

describe("購入商品の名称・重量の選択", () => {
  const line = () =>
    buySchema.parse({
      idempotencyKey: randomUUID(),
      draftId: randomUUID(),
      context: { businessUnitId: randomUUID(), operatorId: randomUUID(), year: 2026 },
      date: "2026-11-15",
      locationId: randomUUID(),
      received: false,
      supplierName: "取引先",
      currency: "CNY",
      exchangeRate: "20",
      lines: [
        {
          clientId: randomUUID(),
          name: "中国語の商品名",
          sourceName: "中国語の商品名",
          trackingMode: "QUANTITY",
          quantity: 7,
          amount: "12.34",
          priceBasis: "UNIT",
          condition: "確認メモ",
        },
      ],
    }).lines[0]!;
  const choice: PurchaseChoice = {
    id: randomUUID(),
    variantId: randomUUID(),
    name: "統一名",
    code: "ITEM",
    mode: "QUANTITY",
    measurements: {
      weight: { value: "25.5", date: "2026-10-01", code: "P001" },
      volume: { value: "123", date: "2026-10-01", code: "P001" },
    },
    history: {
      name: "以前の名称",
      sourceName: "元名称",
      date: "2026-10-01",
      code: "P001",
      supplier: "別の取引先",
      quantity: 100,
      amount: "99",
      currency: "USD",
      priceBasis: "LINE",
    },
  };
  it("選択で商品・名称・寸法だけを反映し、取込済みの価格・数量・元名称を保持する", () => {
    const before = Object.freeze(line());
    expect(applyPurchaseChoice(before, choice)).toEqual({
      ...before,
      variantId: choice.variantId,
      name: choice.name,
      weight: "25.5",
      volume: "123",
    });
    expect(before.amount).toBe("12.34");
  });
  it("履歴がない重量は空欄とし、明細金額入力も保持する", () => {
    const before = { ...line(), priceBasis: "LINE" as const, weight: "50", volume: "10" };
    expect(applyPurchaseChoice(before, { ...choice, measurements: {} })).toEqual({
      ...before,
      name: choice.name,
      variantId: choice.variantId,
      weight: "",
      volume: "",
    });
  });
  it("管理方法と用途が異なる商品への紐づけを拒否する", () => {
    expect(() => applyPurchaseChoice(line(), { ...choice, mode: "UNIQUE" })).toThrow();
    expect(() => applyPurchaseChoice({ ...line(), purpose: "MATERIAL" }, choice)).toThrow();
  });
});
