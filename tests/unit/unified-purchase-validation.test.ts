import { describe, expect, it } from "vitest";
import { unifiedPurchaseSchema } from "@/lib/validation/inventory";

const header = {
  purchasedDate: "2026-08-13",
  supplierId: "11111111-1111-4111-8111-111111111111",
  storageLocationId: "22222222-2222-4222-8222-222222222222",
  orderNumber: "",
  purchaseTotalJpy: "70000",
  memo: "",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
};

describe("統合仕入入力", () => {
  it("数量管理と個体管理の混在、新品と中古の任意組合せを受け付ける", () => {
    const result = unifiedPurchaseSchema.parse({
      ...header,
      newProducts: [],
      lines: [
        {
          clientRef: "44444444-4444-4444-8444-444444444444",
          variant: { source: "EXISTING", variantId: "55555555-5555-4555-8555-555555555555" },
          trackingMode: "QUANTITY",
          conditionCategory: "USED",
          conditionDescription: "状態共通",
          sourceName: "中古まとめ",
          sourceUrl: "",
          quantity: 50,
          amountJpy: "50000",
          commonMeasurements: { サイズ: "M" },
        },
        {
          clientRef: "66666666-6666-4666-8666-666666666666",
          variant: { source: "EXISTING", variantId: "77777777-7777-4777-8777-777777777777" },
          trackingMode: "UNIQUE",
          conditionCategory: "NEW",
          conditionDescription: "新品・個体管理",
          sourceName: "限定品",
          sourceUrl: "https://example.com/item",
          quantity: 1,
          amountJpy: "20000",
          individualCode: "",
          measurements: {},
          memo: "",
        },
      ],
    });
    expect(result.lines.map((line) => line.trackingMode)).toEqual(["QUANTITY", "UNIQUE"]);
    expect(result.lines.map((line) => line.conditionCategory)).toEqual(["USED", "NEW"]);
  });

  it("仕入内で作る商品とバリアントを参照できる", () => {
    const productRef = "88888888-8888-4888-8888-888888888888";
    const variantRef = "99999999-9999-4999-8999-999999999999";
    const result = unifiedPurchaseSchema.safeParse({
      ...header,
      purchaseTotalJpy: "1000",
      newProducts: [
        {
          clientRef: productRef,
          itemCode: "",
          name: "Tシャツ",
          category: "衣類",
          defaultConditionCategory: "NEW",
          defaultTrackingMode: "QUANTITY",
          memo: "",
          variants: [
            {
              clientRef: variantRef,
              variantCode: "VAR-BLACK-M",
              attributes: { 色: "黒", サイズ: "M" },
            },
          ],
        },
      ],
      lines: [
        {
          clientRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          variant: { source: "NEW", productRef, variantRef },
          trackingMode: "QUANTITY",
          conditionCategory: "NEW",
          conditionDescription: "新品",
          sourceName: "Tシャツ",
          sourceUrl: "",
          quantity: 1,
          amountJpy: "1000",
          commonMeasurements: {},
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
