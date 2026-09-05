import { z } from "zod";

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z0-9_-]{1,40}$/,
    "コードは40文字以内の大文字英数字・ハイフン・アンダースコアで入力してください。",
  );
const yen = z
  .string()
  .trim()
  .regex(/^(0|[1-9][0-9]*)$/, "金額は0以上の整数円で入力してください。");
const textMap = z
  .record(z.string().trim().min(1).max(40), z.string().trim().max(100))
  .refine((value) => Object.keys(value).length <= 20, "項目は20件以内にしてください。");
const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => !value || /^https?:\/\//i.test(value),
    "URLはhttpまたはhttpsで入力してください。",
  );

export const inventoryItemSchema = z.object({
  itemCode: code.or(z.literal("")),
  name: z.string().trim().min(1, "商品名を入力してください。").max(120),
  category: z.string().trim().max(80),
  managementType: z.enum(["QUANTITY", "UNIQUE"]),
  defaultConditionCategory: z.enum(["UNSPECIFIED", "NEW", "USED"]).default("UNSPECIFIED"),
  defaultStorageLocationId: z.string().uuid().or(z.literal("")),
  attributes: textMap.default({}),
  memo: z.string().trim().max(1000),
});

const variantSelection = z.discriminatedUnion("source", [
  z.object({ source: z.literal("EXISTING"), variantId: z.string().uuid() }),
  z.object({
    source: z.literal("NEW"),
    productRef: z.string().uuid(),
    variantRef: z.string().uuid(),
  }),
]);

const newVariant = z.object({
  clientRef: z.string().uuid(),
  variantCode: code.or(z.literal("")),
  attributes: textMap,
});

const newProduct = z.object({
  clientRef: z.string().uuid(),
  itemCode: code.or(z.literal("")),
  name: z.string().trim().min(1, "商品名を入力してください。").max(120),
  category: z.string().trim().max(80),
  defaultConditionCategory: z.enum(["UNSPECIFIED", "NEW", "USED"]),
  defaultTrackingMode: z.enum(["QUANTITY", "UNIQUE"]),
  memo: z.string().trim().max(1000),
  variants: z.array(newVariant).min(1, "バリアントを1件以上作成してください。").max(100),
});

const unifiedLineBase = z.object({
  clientRef: z.string().uuid(),
  variant: variantSelection,
  conditionCategory: z.enum(["UNSPECIFIED", "NEW", "USED"]),
  conditionDescription: z.string().trim().max(200),
  sourceName: z.string().trim().min(1, "元商品名を入力してください。").max(120),
  sourceUrl: optionalUrl,
  amountJpy: yen,
});

const unifiedPurchaseLine = z.discriminatedUnion("trackingMode", [
  unifiedLineBase.extend({
    trackingMode: z.literal("QUANTITY"),
    quantity: z.number().int().positive().max(1_000_000),
    commonMeasurements: textMap.default({}),
  }),
  unifiedLineBase.extend({
    trackingMode: z.literal("UNIQUE"),
    quantity: z.literal(1),
    individualCode: code.or(z.literal("")),
    measurements: textMap.default({}),
    memo: z.string().trim().max(1000),
  }),
]);

export const unifiedPurchaseSchema = z
  .object({
    purchaseId: z.string().uuid().optional(),
    purchasedDate: z.string(),
    supplierId: z.string().uuid(),
    storageLocationId: z.string().uuid(),
    orderNumber: z.string().trim().max(100),
    purchaseTotalJpy: yen,
    memo: z.string().trim().max(1000),
    idempotencyKey: z.string().uuid(),
    newProducts: z.array(newProduct).max(50).default([]),
    lines: z.array(unifiedPurchaseLine).min(1).max(500),
  })
  .superRefine((data, ctx) => {
    const productRefs = new Set(data.newProducts.map((product) => product.clientRef));
    const variantRefs = new Set(
      data.newProducts.flatMap((product) =>
        product.variants.map((variant) => `${product.clientRef}:${variant.clientRef}`),
      ),
    );
    for (const [index, line] of data.lines.entries()) {
      if (line.variant.source === "NEW") {
        const key = `${line.variant.productRef}:${line.variant.variantRef}`;
        if (!productRefs.has(line.variant.productRef) || !variantRefs.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["lines", index, "variant"],
            message: "新規商品のバリアントを確認してください。",
          });
        }
      }
      if (line.trackingMode === "UNIQUE" && !line.conditionDescription) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "conditionDescription"],
          message: "個体の状態を入力してください。",
        });
      }
    }
  });

const purchaseLineBase = z.object({
  variantId: z.string().uuid(),
  sourceName: z.string().trim().min(1).max(120),
  sourceUrl: optionalUrl,
  quantity: z.number().int().positive().max(1_000_000),
  amountJpy: yen,
});

export const quantityPurchaseSchema = z.object({
  purchaseId: z.string().uuid().optional(),
  purchasedDate: z.string(),
  supplierId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  orderNumber: z.string().trim().max(100),
  purchaseTotalJpy: yen,
  memo: z.string().trim().max(1000),
  idempotencyKey: z.string().uuid(),
  lines: z.array(purchaseLineBase).min(1).max(100),
});

export const usedBundlePurchaseSchema = z.object({
  purchaseId: z.string().uuid().optional(),
  purchasedDate: z.string(),
  supplierId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  purchaseTotalJpy: yen,
  expectedItemCount: z.number().int().positive().max(500),
  memo: z.string().trim().max(1000),
  idempotencyKey: z.string().uuid(),
  lines: z
    .array(
      purchaseLineBase.extend({
        quantity: z.literal(1),
        individualCode: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9_-]{1,50}$/)
          .or(z.literal("")),
        condition: z.string().trim().min(1, "状態を入力してください。").max(200),
        measurements: textMap.default({}),
        memo: z.string().trim().max(1000),
      }),
    )
    .min(1)
    .max(500),
});

export const inventoryOperationSchema = z
  .object({
    operationType: z.enum([
      "LOCATION_TRANSFER",
      "DISPOSAL",
      "LOSS",
      "PERSONAL_USE",
      "ADJUSTMENT_IN",
      "ADJUSTMENT_OUT",
    ]),
    variantId: z.string().uuid(),
    trackingMode: z.enum(["QUANTITY", "UNIQUE"]),
    uniqueStockUnitId: z.string().uuid().or(z.literal("")),
    quantity: z.number().int().positive().max(1_000_000),
    fromLocationId: z.string().uuid().or(z.literal("")),
    toLocationId: z.string().uuid().or(z.literal("")),
    occurredDate: z.string(),
    unitCostJpy: yen.or(z.literal("")),
    reason: z.enum(["入力漏れ", "紛失", "破損", "廃棄", "私用", "数え間違い", "その他"]),
    note: z.string().trim().max(1000),
    idempotencyKey: z.string().uuid(),
  })
  .superRefine((data, ctx) => {
    if (data.reason === "その他" && !data.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "その他の理由を入力してください。" });
    }
    if (
      data.operationType === "LOCATION_TRANSFER" &&
      (!data.fromLocationId || !data.toLocationId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["toLocationId"],
        message: "移動元と移動先を選択してください。",
      });
    }
    if (
      data.operationType === "LOCATION_TRANSFER" &&
      data.fromLocationId &&
      data.fromLocationId === data.toLocationId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["toLocationId"],
        message: "移動先には移動元と異なる保管場所を選択してください。",
      });
    }
    if (data.operationType === "ADJUSTMENT_IN" && !data.unitCostJpy) {
      ctx.addIssue({
        code: "custom",
        path: ["unitCostJpy"],
        message: "増加時は1個原価を入力してください。",
      });
    }
  });

export function parsePayload<T>(formData: FormData, schema: z.ZodType<T>): T {
  const raw = formData.get("payload");
  if (typeof raw !== "string") throw new Error("入力内容を確認してください。");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("入力形式を確認してください。");
  }
  return schema.parse(value);
}

export { code as inventoryCodeSchema, textMap as textMapSchema, yen as yenSchema };
