import { z } from "zod";

const uuid = z.string().uuid("操作を再読み込みしてやり直してください。");
const yen = z
  .string()
  .trim()
  .regex(/^(0|[1-9][0-9]*)$/, "金額は0以上の整数円で入力してください。");
const optionalYen = z.union([yen, z.literal("")]);
const dateTime = z.string().min(1, "日時を入力してください。");

export const salesSkuSchema = z
  .object({
    name: z.string().trim().min(1, "SKU名を入力してください。").max(120),
    skuType: z.enum(["SINGLE", "BUNDLE"]),
    description: z.string().trim().max(1000),
    expectedPriceJpy: optionalYen,
    idempotencyKey: uuid,
    components: z
      .array(
        z.object({
          itemVariantId: z.string().uuid().or(z.literal("")),
          uniqueStockUnitId: z.string().uuid().or(z.literal("")),
          requiredQuantity: z.number().int().positive(),
        }),
      )
      .min(1, "構成品を1件以上追加してください。"),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.components.forEach((component, index) => {
      if (Boolean(component.itemVariantId) === Boolean(component.uniqueStockUnitId)) {
        context.addIssue({
          code: "custom",
          path: ["components", index],
          message: "商品または個体のどちらか一方を選択してください。",
        });
      }
      const key = component.uniqueStockUnitId || component.itemVariantId;
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: ["components", index],
          message: "同じ構成品は重複登録できません。",
        });
      seen.add(key);
      if (component.uniqueStockUnitId && component.requiredQuantity !== 1) {
        context.addIssue({
          code: "custom",
          path: ["components", index, "requiredQuantity"],
          message: "個体の必要数量は1です。",
        });
      }
    });
    if (value.skuType === "SINGLE" && value.components.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "単品SKUの構成品は1件です。",
      });
    }
  });

export const listingSchema = z.object({
  salesSkuId: z.string().uuid(),
  externalListingId: z.string().trim().max(120),
  url: z
    .string()
    .trim()
    .url("URLを確認してください。")
    .refine((value) => /^https?:\/\//.test(value), "httpまたはhttpsのURLを入力してください。")
    .or(z.literal("")),
  listedAt: dateTime,
  currentPriceJpy: yen,
  listedQuantity: z.number().int().positive(),
  expectedShippingJpy: optionalYen,
  feeRatePercent: z.string().trim().min(1, "手数料率を入力してください。"),
  status: z.enum(["DRAFT", "ACTIVE"]),
  idempotencyKey: uuid,
});

export const saleSchema = z.object({
  listingId: z.string().uuid(),
  quantity: z.number().int().positive(),
  orderedAt: dateTime,
  externalOrderId: z.string().trim().max(120),
  discountJpy: yen,
  packingJpy: optionalYen,
  otherCostJpy: optionalYen,
  memo: z.string().trim().max(1000),
  idempotencyKey: uuid,
});

export const shipmentSchema = z.object({
  orderId: z.string().uuid(),
  shippedAt: dateTime,
  shippingMethod: z.string().trim().min(1).max(120),
  trackingNumber: z.string().trim().max(120),
  actualShippingJpy: yen,
  idempotencyKey: uuid,
});

export const completionSchema = z.object({
  orderId: z.string().uuid(),
  completedAt: dateTime,
  feeJpy: yen,
  idempotencyKey: uuid,
});

export const cancellationSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().min(1, "取消理由を入力してください。").max(500),
  idempotencyKey: uuid,
});

export const returnSchema = z
  .object({
    orderId: z.string().uuid(),
    lineId: z.string().uuid(),
    quantity: z.number().int().positive(),
    returnedAt: dateTime,
    dispositions: z
      .array(
        z
          .object({
            itemVariantId: z.string().uuid().nullable(),
            uniqueStockUnitId: z.string().uuid().nullable(),
            disposition: z.enum(["RESTOCK", "DEFECTIVE", "DISPOSED"]),
          })
          .refine((row) => Boolean(row.itemVariantId) !== Boolean(row.uniqueStockUnitId), {
            message: "返品する構成品を確認してください。",
          }),
      )
      .min(1, "構成品ごとの処理を選択してください。"),
    salesRefundJpy: yen,
    feeRefundJpy: yen,
    shippingRefundJpy: yen,
    memo: z.string().trim().max(1000),
    idempotencyKey: uuid,
  })
  .superRefine((input, context) => {
    const keys = input.dispositions.map(
      (row) => row.uniqueStockUnitId ?? `variant:${row.itemVariantId}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["dispositions"],
        message: "同じ構成品の返品処理が重複しています。",
      });
    }
  });

export function parseJsonField<T>(formData: FormData, name: string): T {
  const raw = formData.get(name);
  if (typeof raw !== "string") throw new Error("入力内容を確認してください。");
  return JSON.parse(raw) as T;
}
