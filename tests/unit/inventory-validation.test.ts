import { describe, expect, it } from "vitest";
import {
  inventoryItemSchema,
  inventoryOperationSchema,
  usedBundlePurchaseSchema,
} from "@/lib/validation/inventory";

describe("phase 1 validation", () => {
  it("normalizes an editable item code", () => {
    const parsed = inventoryItemSchema.parse({
      itemCode: "item-custom",
      name: "商品",
      category: "",
      managementType: "QUANTITY",
      defaultStorageLocationId: "",
      attributes: {},
      memo: "",
    });
    expect(parsed.itemCode).toBe("ITEM-CUSTOM");
  });

  it("accepts blank individual codes for atomic auto-numbering", () => {
    const parsed = usedBundlePurchaseSchema.parse({
      purchasedDate: "2026-08-13",
      supplierId: "00000000-0000-4000-8000-000000000001",
      storageLocationId: "00000000-0000-4000-8000-000000000002",
      purchaseTotalJpy: "20000",
      expectedItemCount: 1,
      memo: "",
      idempotencyKey: "00000000-0000-4000-8000-000000000003",
      lines: [
        {
          variantId: "00000000-0000-4000-8000-000000000004",
          sourceName: "古着",
          sourceUrl: "",
          quantity: 1,
          amountJpy: "20000",
          individualCode: "",
          condition: "良好",
          measurements: {},
          memo: "",
        },
      ],
    });
    expect(parsed.lines[0]?.individualCode).toBe("");
  });

  it("rejects unsafe source URLs", () => {
    const result = usedBundlePurchaseSchema.safeParse({
      purchasedDate: "2026-08-13",
      supplierId: "00000000-0000-4000-8000-000000000001",
      storageLocationId: "00000000-0000-4000-8000-000000000002",
      purchaseTotalJpy: "1000",
      expectedItemCount: 1,
      memo: "",
      idempotencyKey: "00000000-0000-4000-8000-000000000003",
      lines: [
        {
          variantId: "00000000-0000-4000-8000-000000000004",
          sourceName: "古着",
          sourceUrl: "javascript:alert(1)",
          quantity: 1,
          amountJpy: "1000",
          individualCode: "UNIT-1",
          condition: "良好",
          measurements: {},
          memo: "",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a location transfer to the same storage location", () => {
    const locationId = "00000000-0000-4000-8000-000000000005";
    const result = inventoryOperationSchema.safeParse({
      operationType: "LOCATION_TRANSFER",
      variantId: "00000000-0000-4000-8000-000000000004",
      trackingMode: "QUANTITY",
      uniqueStockUnitId: "",
      quantity: 1,
      fromLocationId: locationId,
      toLocationId: locationId,
      occurredDate: "2026-08-13",
      unitCostJpy: "",
      reason: "数え間違い",
      note: "",
      idempotencyKey: "00000000-0000-4000-8000-000000000003",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        "移動先には移動元と異なる保管場所を選択してください。",
      );
    }
  });
});
