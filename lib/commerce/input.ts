import { z } from "zod";
import "@/lib/validation/locale";
import { saleSourceSchema } from "./sale-source";
import {
  componentsSchema,
  eventDate,
  valuationFields,
  workflowContextSchema,
} from "@/lib/validation/workflow";
import { allocationMethods, convertMoney, Precise } from "./allocation";

export const yen = z.string().regex(/^(0|[1-9]\d{0,14})$/, "0以上の整数円を入力してください。");
export const optionalYen = z.union([yen, z.literal("")]).default("");
export const decimal = z
  .string()
  .regex(/^(0|[1-9]\d{0,14})(\.\d{1,8})?$/, "0以上の数値を入力してください。");
export const optionalDecimal = z.union([decimal, z.literal("")]).default("");
export const baseFields = {
  idempotencyKey: z.uuid(),
  context: workflowContextSchema,
  ...valuationFields,
};
export const documentLineSchema = z
  .object({
    purpose: z.enum(["STOCK", "MATERIAL", "EQUIPMENT"]).optional(),
    supplyItemId: z.union([z.uuid(), z.literal("")]).optional(),
    supplyUnit: z.string().trim().min(1).max(20).optional(),
    clientId: z.uuid(),
    variantId: z.union([z.uuid(), z.literal("")]).default(""),
    name: z.string().trim().min(1, "商品名を入力してください。").max(120),
    sourceName: z.string().trim().min(1).max(1000).optional(),
    trackingMode: z.enum(["QUANTITY", "UNIQUE"]),
    quantity: z.number().int().min(1).max(1000000),
    amount: decimal,
    priceBasis: z.enum(["UNIT", "LINE"]).default("UNIT"),
    weight: optionalDecimal,
    volume: optionalDecimal,
    condition: z.string().trim().max(1000).default(""),
  })
  .refine((l) => l.trackingMode !== "UNIQUE" || l.quantity === 1, {
    message: "1点ごとの管理は明細を分けてください。",
    path: ["quantity"],
  });
export const chargeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  amount: optionalDecimal,
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "通貨コードを確認してください。")
    .optional(),
  exchangeRate: optionalDecimal.optional(),
  actualJpy: optionalYen.optional(),
  method: z.enum(allocationMethods).default("VALUE"),
  capitalized: z.boolean().default(true),
  lineIds: z.array(z.uuid()).max(200).default([]),
  manual: z.record(z.string(), optionalDecimal).default({}),
});
export const purchasePaymentSchema = z
  .object({
    method: z.enum(["NONE", "ACCOUNT", "PERSONAL"]),
    date: eventDate,
    amount: optionalYen,
    accountId: z.union([z.uuid(), z.literal("")]).default(""),
    accountRevision: z.number().int().nonnegative().default(0),
  })
  .refine((p) => p.method === "NONE" || p.amount !== "", {
    path: ["amount"],
    message: "支払額を入力してください。",
  })
  .refine((p) => p.method !== "ACCOUNT" || !!p.accountId, {
    path: ["accountId"],
    message: "支払口座を選択してください。",
  });
export const buySchema = z
  .object({
    ...baseFields,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "通貨コードを確認してください。")
      .optional(),
    exchangeRate: optionalDecimal.optional(),
    actualOrderJpy: optionalYen.optional(),
    externalReference: z.string().trim().max(150).optional(),
    importSource: z
      .object({
        adapterId: z.string().max(80),
        fileName: z.string().max(250),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
    draftId: z.uuid(),
    draftRevision: z.number().int().min(0).default(0),
    date: eventDate,
    supplierId: z.union([z.uuid(), z.literal("")]).default(""),
    supplierName: z.string().trim().max(100),
    supplierRevision: z.number().int().min(0).optional(),
    locationId: z.uuid(),
    received: z.boolean(),
    createSkus: z.boolean().optional(),
    payment: purchasePaymentSchema.optional(),
    taxMode: z.enum(["INCLUDED", "EXCLUDED"]).default("INCLUDED"),
    taxAmount: optionalYen,
    memo: z.string().trim().max(2000).default(""),
    lines: z.array(documentLineSchema).min(1).max(200),
    charges: z.array(chargeSchema).max(50).default([]),
  })
  .refine((i) => !!i.supplierId || !!i.supplierName, {
    message: "取引先を入力してください。",
    path: ["supplierName"],
  })
  .refine((i) => new Set(i.lines.map((l) => l.clientId)).size === i.lines.length, {
    message: "明細が重複しています。",
    path: ["lines"],
  });
export const receiveSchema = z
  .object({
    ...baseFields,
    date: eventDate,
    purchaseId: z.uuid(),
    revision: z.number().int().min(0),
    locationId: z.uuid(),
    lines: z
      .array(
        z.object({
          lineId: z.uuid(),
          quantity: z.number().int().positive(),
          deliveryLineId: z.uuid().optional(),
        }),
      )
      .min(1)
      .max(200),
  })
  .refine(
    (i) => new Set(i.lines.map((l) => l.lineId)).size === i.lines.length,
    "受取明細が重複しています。",
  );
export const saleSchema = z.object({
  importSource: saleSourceSchema.optional(),
  supplyQuantities: z.record(z.uuid(), optionalDecimal).optional(),
  materialQuote: z
    .array(
      z.object({
        settingId: z.uuid(),
        unitCost: optionalDecimal,
        sourceLineId: z.uuid().nullable(),
        final: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
  ...baseFields,
  draftId: z.uuid(),
  draftRevision: z.number().int().min(0).default(0),
  date: eventDate,
  skuId: z.uuid(),
  skuRevision: z.number().int().min(0),
  channelId: z.uuid(),
  channelRevision: z.number().int().min(0),
  quantity: z.number().int().positive().max(1000000),
  price: yen,
  fee: optionalYen,
  shipping: optionalYen,
  deliveryMethodId: z.union([z.uuid(), z.literal("")]).default(""),
  externalId: z.string().trim().max(150).default(""),
  buyer: z.string().trim().max(150).default(""),
  memo: z.string().trim().max(2000).default(""),
});
export const skuSchema = z
  .object({
    supplies: z
      .array(
        z.object({
          supplyItemId: z.uuid(),
          purpose: z.enum(["PACKING", "COMPONENT"]),
          quantity: decimal,
          unitCost: optionalDecimal,
        }),
      )
      .max(100)
      .optional(),
    ...baseFields,
    date: eventDate,
    id: z.union([z.uuid(), z.literal("")]).default(""),
    revision: z.number().int().min(0).default(0),
    name: z.string().trim().min(1, "SKU名を入力してください。").max(120),
    price: optionalYen,
    components: componentsSchema,
    channels: z
      .array(
        z.object({
          channelId: z.uuid(),
          price: optionalYen,
          shipping: optionalYen,
          deliveryMethodId: z.union([z.uuid(), z.literal("")]).default(""),
        }),
      )
      .max(50)
      .default([]),
  })
  .refine(
    (i) => new Set(i.channels.map((c) => c.channelId)).size === i.channels.length,
    "販路が重複しています。",
  );
export const skuBatchSchema = z
  .object({
    ...baseFields,
    date: eventDate,
    selection: z.array(z.uuid()).min(1).max(200).optional(),
    products: z
      .array(
        z.object({
          variantId: z.uuid().nullable(),
          unitId: z.uuid().nullable(),
          name: z.string().trim().min(1).max(120),
        }),
      )
      .min(1)
      .max(200)
      .optional(),
  })
  .refine((i) => !!i.selection !== !!i.products, "商品を選択してください。")
  .refine(
    (i) =>
      i.selection
        ? new Set(i.selection).size === i.selection.length
        : i.products!.every((p) => !!p.variantId !== !!p.unitId) &&
          new Set(i.products!.map((p) => p.variantId ?? p.unitId)).size === i.products!.length,
    "商品を重複なく選択してください。",
  );
export const methodSchema = z.object({
  ...baseFields,
  date: eventDate,
  id: z.union([z.uuid(), z.literal("")]).default(""),
  revision: z.number().int().min(0).default(0),
  name: z.string().trim().min(1).max(80),
  shipping: optionalYen,
  allocationMethod: z.enum(allocationMethods).default("VALUE"),
});
export const channelSchema = z
  .object({
    receivingAccountId: z.union([z.uuid(), z.literal("")]).optional(),
    feeDeducted: z.boolean().optional(),
    shippingDeducted: z.boolean().optional(),
    ...baseFields,
    date: eventDate,
    id: z.union([z.uuid(), z.literal("")]).default(""),
    revision: z.number().int().min(0).default(0),
    name: z.string().trim().min(1).max(80),
    feeRate: optionalDecimal,
    shipping: optionalYen,
    deliveryMethodId: z.union([z.uuid(), z.literal("")]).default(""),
  })
  .refine((i) => i.feeRate === "" || new Precise(i.feeRate).lte(100), {
    message: "手数料率は0〜100%で入力してください。",
    path: ["feeRate"],
  });
export const commerceDraftRebaseSchema = z.object({
  ...baseFields,
  date: eventDate,
  draftId: z.uuid(),
  revision: z.number().int().nonnegative(),
  kind: z.enum(["COMMERCE_PURCHASE", "COMMERCE_SALE"]),
  choice: z.enum(["LOCAL", "CURRENT"]),
  values: z.record(z.string(), z.unknown()),
});
export const costBasesSchema = z.record(
  z.string(),
  z.object({ weight: optionalDecimal, volume: optionalDecimal, manual: optionalDecimal }),
);
export const purchaseCostSchema = z
  .object({
    ...baseFields,
    date: eventDate,
    purchaseId: z.uuid().optional(),
    deliveryId: z.uuid().optional(),
    revision: z.number().int().nonnegative(),
    additionalCharges: z.array(chargeSchema).max(49).default([]),
    charge: chargeSchema,
    supersedesId: z.uuid().optional(),
    reason: z.string().trim().min(1, "追加・訂正の理由を入力してください。").max(1000),
    bases: costBasesSchema.default({}),
    refund: z.boolean().default(false),
    receiptLinks: z
      .array(
        z.object({
          receiptLineId: z.uuid(),
          deliveryLineId: z.uuid(),
          quantity: z.number().int().positive(),
        }),
      )
      .max(200)
      .default([]),
  })
  .refine((i) => !!i.purchaseId !== !!i.deliveryId, "購入または配送を選択してください。");
export const deliverySchema = z
  .object({
    ...baseFields,
    date: eventDate,
    deliveryMethodId: z.union([z.uuid(), z.literal("")]).default(""),
    methodRevision: z.number().int().nonnegative().optional(),
    counterpartyId: z.union([z.uuid(), z.literal("")]).default(""),
    reference: z.string().trim().max(150).default(""),
    memo: z.string().trim().max(1000).default(""),
    reason: z.string().trim().max(1000).default(""),
    lines: z
      .array(
        z.object({
          lineId: z.uuid(),
          quantity: z.number().int().positive(),
          purchaseRevision: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(200),
    charges: z.array(chargeSchema).max(50).default([]),
    bases: costBasesSchema.default({}),
    receiptLinks: z
      .array(
        z.object({
          lineId: z.uuid(),
          receiptLineId: z.uuid(),
          quantity: z.number().int().positive(),
        }),
      )
      .max(200)
      .default([]),
  })
  .refine(
    (i) => new Set(i.lines.map((l) => l.lineId)).size === i.lines.length,
    "配送明細が重複しています。",
  );
export const purchaseReturnSchema = z.object({
  ...baseFields,
  date: eventDate,
  receiptLineId: z.uuid(),
  revision: z.number().int().nonnegative(),
  quantity: z.number().int().positive().max(1000000),
  refund: optionalYen,
  reason: z.string().trim().min(1, "返送理由を入力してください。").max(1000),
});
export const accountSchema = z.object({
  accountKind: z.enum(["STANDARD", "CREDIT_CARD"]).optional(),
  ...baseFields,
  date: eventDate,
  id: z.union([z.uuid(), z.literal("")]).default(""),
  revision: z.number().int().nonnegative().default(0),
  name: z.string().trim().min(1, "口座名を入力してください。").max(100),
  balance: z.string().regex(/^-?(0|[1-9]\d{0,14})$/, "開始残高を整数円で入力してください。"),
  active: z.boolean().default(true),
});
export const moneySchema = z
  .object({
    paymentMethod: z.enum(["ACCOUNT", "PERSONAL"]).optional(),
    ownerFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    ...baseFields,
    date: eventDate,
    kind: z.enum([
      "OWNER_CONTRIBUTION",
      "OWNER_DRAWING",
      "OWNER_REIMBURSEMENT",
      "OWNER_REPAYMENT",
      "FEE_PAYMENT",
      "SHIPPING_PAYMENT",
      "SALE_FEE_REFUND",
      "SALE_SHIPPING_REFUND",
      "OTHER_PAYMENT",
      "OTHER_RECEIPT",
      "PURCHASE_CREDIT_REFUND",
      "DELIVERY_CREDIT_REFUND",
      "SALE_CREDIT_REFUND",
      "SALE_SETTLEMENT_PAYMENT",
      "PURCHASE_PAYMENT",
      "DELIVERY_PAYMENT",
      "PURCHASE_REFUND",
      "SUPPLIER_RETURN_REFUND",
      "SALE_RECEIPT",
      "SALE_REFUND",
      "TRANSFER",
      "REVERSAL",
    ]),
    amount: yen.default("0"),
    fee: optionalYen.default(""),
    accountId: z.union([z.uuid(), z.literal("")]).default(""),
    accountRevision: z.number().int().nonnegative().default(0),
    toAccountId: z.union([z.uuid(), z.literal("")]).default(""),
    toAccountRevision: z.number().int().nonnegative().default(0),
    sourceId: z.uuid().optional(),
    sourceRevision: z.number().int().nonnegative().optional(),
    reversesId: z.uuid().optional(),
    memo: z.string().trim().max(1000).default(""),
  })
  .refine((input) => input.kind !== "REVERSAL" || !!input.reversesId, {
    path: ["reversesId"],
    message: "取消対象の入出金を指定してください。",
  });
export const materialUseSchema = z.object({
  ...baseFields,
  date: eventDate,
  saleId: z.uuid(),
  saleRevision: z.number().int().nonnegative(),
  supplyItemId: z.uuid(),
  purpose: z.enum(["PACKING", "COMPONENT"]),
  quantity: decimal,
  unitCost: optionalDecimal,
  sourceLineId: z.uuid().nullable(),
  manualPrice: z.boolean(),
  reason: z.string().trim().min(1, "追加・訂正の理由を入力してください。").max(1000),
  supersedesId: z.uuid().optional(),
});
export const otherRecordSchema = z
  .object({
    paymentMethod: z.enum(["ACCOUNT", "PERSONAL"]).optional(),
    ...baseFields,
    date: eventDate,
    kind: z.enum(["EXPENSE", "INCOME"]),
    amount: yen,
    categoryId: z.union([z.uuid(), z.literal("")]).default(""),
    categoryName: z.string().trim().max(100),
    categoryRevision: z.number().int().nonnegative().optional(),
    sourceSaleId: z.uuid().optional(),
    sourcePurchaseId: z.uuid().optional(),
    counterparty: z.string().trim().max(150).default(""),
    memo: z.string().trim().max(1000).default(""),
    settled: z.boolean().default(false),
    accountId: z.union([z.uuid(), z.literal("")]).default(""),
    accountRevision: z.number().int().nonnegative().default(0),
    reversesId: z.uuid().optional(),
  })
  .refine(
    (i) => !!i.reversesId || !!i.categoryId || !!i.categoryName,
    "収支の項目名を入力してください。",
  );
export const categorySchema = z.object({
  ...baseFields,
  date: eventDate,
  id: z.union([z.uuid(), z.literal("")]).default(""),
  revision: z.number().int().nonnegative().default(0),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["EXPENSE", "INCOME"]),
  active: z.boolean().default(true),
});
export const supplierConfigSchema = z.object({
  ...baseFields,
  date: eventDate,
  id: z.union([z.uuid(), z.literal("")]).default(""),
  revision: z.number().int().nonnegative().default(0),
  name: z.string().trim().min(1).max(100),
  currency: z.string().regex(/^[A-Z]{3}$/, "通貨コードを確認してください。"),
  allocationMethod: z.enum(allocationMethods),
  memo: z.string().trim().max(2000).default(""),
  active: z.boolean().default(true),
});
export const buyCancelSchema = z.object({
  ...baseFields,
  date: eventDate,
  purchaseId: z.uuid(),
  revision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1, "取消理由を入力してください。").max(1000),
  confirmed: z.literal(true, "取消する内容を確認してください。"),
});
export const itemSaveSchema = z.object({
  ...baseFields,
  date: eventDate,
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  name: z.string().trim().min(1, "商品名を入力してください。").max(120),
  category: z.string().trim().max(100).default(""),
  memo: z.string().trim().max(2000).default(""),
  locationId: z.union([z.uuid(), z.literal("")]).default(""),
  active: z.boolean(),
});
export const supplySaveSchema = z.object({
  ...baseFields,
  date: eventDate,
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  name: z.string().trim().min(1, "名称を入力してください。").max(120),
  memo: z.string().trim().max(2000).default(""),
  active: z.boolean(),
});
export const commerceSchemas = {
  ITEM_SAVE: itemSaveSchema,
  SUPPLY_SAVE: supplySaveSchema,
  BUY_CANCEL: buyCancelSchema,
  SUPPLIER_CONFIG: supplierConfigSchema,
  OTHER_RECORD: otherRecordSchema,
  CATEGORY_SAVE: categorySchema,
  MATERIAL_USE: materialUseSchema,
  ACCOUNT_SAVE: accountSchema,
  MONEY_RECORD: moneySchema,
  PURCHASE_RETURN: purchaseReturnSchema,
  DELIVERY: deliverySchema,
  PURCHASE_COST: purchaseCostSchema,
  PURCHASE_REFUND: purchaseCostSchema,
  DRAFT_REBASE: commerceDraftRebaseSchema,
  BUY: buySchema,
  RECEIVE: receiveSchema,
  SALE: saleSchema,
  SKU_SAVE: skuSchema,
  SKU_BATCH: skuBatchSchema,
  DELIVERY_METHOD: methodSchema,
  CHANNEL_SAVE: channelSchema,
};
export type CommerceKind = keyof typeof commerceSchemas;
export type BuyInput = z.infer<typeof buySchema>;
export type SaleInput = z.infer<typeof saleSchema>;
export type SkuInput = z.infer<typeof skuSchema>;
export const lineAmount = (
  line: { amount: string; priceBasis: string; quantity: number },
  currency = "JPY",
  rate = "1",
) =>
  convertMoney(
    new Precise(line.amount).mul(line.priceBasis === "UNIT" ? line.quantity : 1).toFixed(),
    currency,
    rate,
  );
