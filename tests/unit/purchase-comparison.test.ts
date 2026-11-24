import { describe, it, expect } from "vitest";
import { purchaseValues, purchaseDifferences } from "@/lib/inventory/purchase-comparison";
import type { PurchaseUiSnapshot } from "@/components/forms/purchase-form";
const input: PurchaseUiSnapshot = {
  date: "2026-10-04",
  supplierId: "s",
  locationId: "l",
  orderNumber: "注文",
  total: "100",
  memo: "",
  requestKey: "key",
  products: [],
  step: 3,
  lines: [
    {
      clientRef: "a",
      variant: { source: "EXISTING", variantId: "v" },
      trackingMode: "QUANTITY",
      conditionCategory: "NEW",
      conditionDescription: "良好",
      sourceName: "商品",
      sourceUrl: "",
      quantity: 2,
      amountJpy: "100",
      commonMeasurements: { 肩幅: "40", 着丈: "60" },
    },
  ],
};
const labels = {
  suppliers: [{ id: "s", label: "仕入先" }],
  locations: [{ id: "l", label: "自宅" }],
  variants: [{ id: "v", label: "商品 青" }],
};
describe("purchase comparison", () => {
  it("ignores UI ids and map key order but preserves quantities, money and measurements", () => {
    const original = purchaseValues(input, labels);
    const same = purchaseValues(
      {
        ...input,
        requestKey: "another",
        lines: [
          { ...input.lines[0]!, clientRef: "b", commonMeasurements: { 着丈: "60", 肩幅: "40" } },
        ],
      },
      labels,
    );
    expect(same).toEqual(original);
    const changed = purchaseValues(
      { ...input, total: "0", lines: [{ ...input.lines[0]!, quantity: 3 }] },
      labels,
    );
    expect(
      purchaseDifferences(original, original, changed)
        .filter((x) => x.changed)
        .map((x) => x.key),
    ).toEqual(["total", "lines"]);
    expect(purchaseValues({ ...input, total: "" }, labels).total).not.toBe(changed.total);
  });
  it("keeps duplicate lines and labels an absent baseline without fabricating it", () => {
    const values = purchaseValues(input, labels);
    expect(
      purchaseValues({ ...input, lines: [...input.lines, ...input.lines] }, labels).lines!.split(
        "\n",
      ),
    ).toHaveLength(2);
    expect(purchaseDifferences(null, values, values)[0]!.base).toContain("未記録");
    expect(values.lines).not.toContain('"clientRef"');
    expect(values.lines).toContain("商品 青");
  });
  it("compares individual identity, condition and measurements without rounding yen", () => {
    const unique: PurchaseUiSnapshot = {
      ...input,
      total: "10000000000000001",
      lines: [
        {
          ...input.lines[0]!,
          trackingMode: "UNIQUE",
          quantity: 1,
          individualCode: "UNIT-000001",
          conditionCategory: "USED",
          measurements: { 肩幅: "40cm" },
          commonMeasurements: {},
        },
      ],
    };
    const original = purchaseValues(unique, labels);
    expect(original.total).toBe("¥10,000,000,000,000,001");
    const changed = purchaseValues(
      {
        ...unique,
        lines: [
          {
            ...unique.lines[0]!,
            individualCode: "UNIT-000002",
            conditionDescription: "傷あり",
            measurements: { 肩幅: "41cm" },
          },
        ],
      },
      labels,
    );
    expect(
      purchaseDifferences(original, original, changed)
        .filter((x) => x.changed)
        .map((x) => x.key),
    ).toEqual(["lines"]);
    expect(changed.lines).toContain("UNIT-000002");
    expect(changed.lines).toContain("傷あり");
    expect(changed.lines).toContain("肩幅：41cm");
  });
});
