import { z } from "zod";
import type { PurchaseUiSnapshot } from "@/components/forms/purchase-form";

export const purchaseBaselineSchema = z.object({
  purchaseId: z.uuid().nullable(),
  revision: z.number().int().nonnegative(),
  status: z.enum(["NEW", "DRAFT", "FINALIZED", "CANCELLED"]),
  reportingEntityId: z.uuid().nullable(),
  context: z.object({ businessUnitId: z.uuid(), operatorId: z.uuid(), year: z.number().int() }),
  values: z.record(z.string(), z.string()),
});
export type PurchaseBaseline = z.infer<typeof purchaseBaselineSchema>;
export type PurchaseLabels = {
  suppliers: { id: string; label: string }[];
  locations: { id: string; label: string }[];
  variants: { id: string; label: string }[];
};
export const purchaseFieldNames: Record<string, string> = {
  date: "仕入日",
  supplier: "仕入先",
  location: "保管場所",
  orderNumber: "注文番号",
  total: "仕入総額",
  memo: "メモ",
  lines: "商品・数量・原価・状態・採寸",
  products: "作成中の商品",
};
const money = (v: string) =>
  /^\d+$/.test(v) ? `¥${BigInt(v).toLocaleString("ja-JP")}` : v || "未入力";
const measurements = (v?: Record<string, string>) =>
  Object.entries(v ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, x]) => `${k}：${x}`)
    .join("、");
export function purchaseValues(
  input: PurchaseUiSnapshot,
  labels: PurchaseLabels,
): Record<string, string> {
  const lookup = (rows: { id: string; label: string }[], id: string) =>
    rows.find((x) => x.id === id)?.label ?? (id ? "現在は選択できない項目" : "未入力");
  return {
    date: input.date || "未入力",
    supplier: lookup(labels.suppliers, input.supplierId),
    location: lookup(labels.locations, input.locationId),
    orderNumber: input.orderNumber || "未入力",
    total: money(input.total),
    memo: input.memo || "未入力",
    lines:
      input.lines
        .map((line) => {
          const selection = line.variant;
          const product =
            selection.source === "NEW"
              ? input.products.find((p) => p.clientRef === selection.productRef)
              : undefined;
          const name =
            selection.source === "EXISTING"
              ? lookup(labels.variants, selection.variantId)
              : `${product?.name ?? "作成中の商品"} ${measurements(product?.variants.find((v) => v.clientRef === selection.variantRef)?.attributes)}`;
          return [
            name,
            line.trackingMode === "QUANTITY" ? "数量管理" : "1点管理",
            `数量 ${line.quantity}`,
            `原価 ${money(line.amountJpy)}`,
            { NEW: "新品", USED: "中古", UNSPECIFIED: "商品区分未指定" }[line.conditionCategory],
            line.conditionDescription,
            line.sourceName,
            line.sourceUrl,
            line.individualCode,
            measurements(line.measurements),
            measurements(line.commonMeasurements),
            line.memo,
          ]
            .filter(Boolean)
            .join("／");
        })
        .sort()
        .join("\n") || "明細なし",
    products:
      input.products
        .map((p) =>
          [
            p.name,
            p.itemCode,
            p.category,
            p.memo,
            { NEW: "新品", USED: "中古", UNSPECIFIED: "商品区分未指定" }[
              p.defaultConditionCategory
            ],
            p.defaultTrackingMode === "QUANTITY" ? "数量管理" : "1点管理",
            ...p.variants.map((v) => `${v.variantCode} ${measurements(v.attributes)}`).sort(),
          ]
            .filter(Boolean)
            .join("／"),
        )
        .sort()
        .join("\n") || "なし",
  };
}
export function purchaseDifferences(
  base: Record<string, string> | null,
  remote: Record<string, string>,
  local: Record<string, string>,
) {
  return Object.keys(purchaseFieldNames)
    .map((key) => ({
      key,
      label: purchaseFieldNames[key]!,
      base: base?.[key] ?? "入力開始時の内容は未記録",
      remote: remote[key] ?? "未入力",
      local: local[key] ?? "未入力",
      changed: (base !== null && base[key] !== remote[key]) || remote[key] !== local[key],
    }))
    .sort((a, b) => Number(b.changed) - Number(a.changed));
}
