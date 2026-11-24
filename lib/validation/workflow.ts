import { z } from "zod";
import "./locale";
import { inventoryOperationSchema, unifiedPurchaseSchema } from "@/lib/validation/inventory";
import { purchaseBaselineSchema } from "@/lib/inventory/purchase-comparison";
import { listingReturnDraftFields } from "@/lib/sales/listing-return-input";
import { inputOriginSchema } from "@/lib/sales/input-origin";

const money = z.string().regex(/^(0|[1-9]\d{0,14})$/, "0以上の整数円を入力してください。");
export const optionalMoney = z
  .union([money, z.literal("")])
  .transform((v) => (v === "" ? null : BigInt(v)));
export const eventDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "存在する日付を入力してください。");
export const workflowContextSchema = z.object({
  reportingEntityId: z.uuid().optional(),
  businessUnitId: z.uuid(),
  operatorId: z.uuid(),
  year: z.number().int(),
});
export const workflowKindSchema = z.enum([
  "ITEM_SAVE",
  "SUPPLY_SAVE",
  "BUY_CANCEL",
  "SUPPLIER_CONFIG",
  "OTHER_RECORD",
  "CATEGORY_SAVE",
  "MATERIAL_USE",
  "ACCOUNT_SAVE",
  "MONEY_RECORD",
  "DELIVERY",
  "PURCHASE_COST",
  "PURCHASE_REFUND",
  "PURCHASE_RETURN",
  "DRAFT_REBASE",
  "BUY",
  "RECEIVE",
  "SALE",
  "SKU_SAVE",
  "SKU_BATCH",
  "DELIVERY_METHOD",
  "CHANNEL_SAVE",
  "SUPPLIER_SAVE",
  "LIST",
  "COMPLETE",
  "EVENT",
  "AMEND",
  "PRICE",
  "REFUND",
  "YEAR_SWITCH",
  "INVENTORY",
  "PURCHASE_SAVE",
  "PURCHASE_RECEIVE",
  "PURCHASE_CANCEL",
  "PURCHASE_REBASE",
  "RETURN",
  "RETURN_REBASE",
  "DATE_CORRECT",
  "STOCKTAKE",
  "LISTING_RETURN",
  "LISTING_RETURN_CLOSE",
  "LISTING_RETURN_REBASE",
]);
export type WorkflowKind = z.infer<typeof workflowKindSchema>;
export const valuationFields = {
  valuationFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  valuationPosition: z.union([z.literal("LAST"), z.uuid()]).optional(),
};
export const inventoryRecordSchema = inventoryOperationSchema.safeExtend({
  ...valuationFields,
  context: workflowContextSchema,
  occurredDate: eventDate,
  inventoryRevision: z.string().regex(/^(0|[1-9]\d*)$/),
});
export const stocktakeRecordSchema = z.object({
  ...valuationFields,
  idempotencyKey: z.uuid(),
  context: workflowContextSchema,
  variantId: z.uuid(),
  locationId: z.uuid(),
  countedDate: eventDate,
  countedQuantity: z.number().int().min(0).max(1000000),
  inventoryRevision: z.string().regex(/^(0|[1-9]\d*)$/),
  unitCostJpy: z.union([money, z.literal("")]),
  reason: z.string().trim().min(1, "数量を確認した理由を入力してください。").max(1000),
});
export const listingReturnSchema = z
  .object({
    ...listingReturnDraftFields,
    ...valuationFields,
    idempotencyKey: z.uuid(),
    context: workflowContextSchema,
    listingId: z.uuid(),
    revision: z.number().int().nonnegative(),
    date: eventDate,
    reason: z.string().trim().min(1).max(1000),
    rows: z
      .array(
        z.object({
          memberId: z.uuid(),
          disposition: z.enum(["RESTOCK", "DEFECTIVE", "DISPOSED", "LOST"]),
          quantity: z.number().int().positive().max(1000000),
        }),
      )
      .min(1)
      .max(500),
  })
  .refine(
    (v) => new Set(v.rows.map((r) => `${r.memberId}:${r.disposition}`)).size === v.rows.length,
    "同じ構成品・処理の重複入力はできません。",
  );
export const listingReturnCloseSchema = z.object({
  ...listingReturnDraftFields,
  idempotencyKey: z.uuid(),
  context: workflowContextSchema,
  listingId: z.uuid(),
  revision: z.number().int().nonnegative(),
  date: eventDate,
  action: z.enum(["END", "RESUME"]),
  goodsInHand: z.literal(true),
  reason: z.string().trim().min(1).max(1000),
});
export const purchaseRecordSchema = unifiedPurchaseSchema.safeExtend({
  baseSnapshot: purchaseBaselineSchema.nullable().optional(),
  context: workflowContextSchema,
  purchasedDate: eventDate,
  revision: z.number().int().nonnegative(),
  draftId: z.uuid(),
  draftRevision: z.number().int().nonnegative(),
});
export const purchaseEventSchema = z.object({
  ...valuationFields,
  baseSnapshot: purchaseBaselineSchema.nullable().optional(),
  idempotencyKey: z.uuid(),
  context: workflowContextSchema,
  purchaseId: z.uuid(),
  revision: z.number().int().nonnegative(),
  date: eventDate,
  reason: z.string().trim().max(1000),
});
export const componentSchema = z
  .object({
    itemVariantId: z.uuid().nullable(),
    uniqueStockUnitId: z.uuid().nullable(),
    requiredQuantity: z.number().int().min(1).max(100000),
  })
  .refine(
    (v) => Boolean(v.itemVariantId) !== Boolean(v.uniqueStockUnitId),
    "商品か個体を1つ選択してください。",
  )
  .refine(
    (v) => !v.uniqueStockUnitId || v.requiredQuantity === 1,
    "個体は1点ずつ指定してください。",
  );
export const componentsSchema = z
  .array(componentSchema)
  .min(1)
  .max(50)
  .refine(
    (rows) => new Set(rows.map((v) => v.itemVariantId ?? v.uniqueStockUnitId)).size === rows.length,
    "同じ商品はまとめて数量を指定してください。",
  );
export const listingRecordSchema = z.object({
  baseSnapshot: inputOriginSchema.nullable().optional(),
  idempotencyKey: z.uuid(),
  context: workflowContextSchema,
  name: z.string().trim().min(1).max(200),
  components: componentsSchema,
  externalReference: z.string().trim().min(1, "出品URLまたは商品IDを入力してください。").max(500),
  price: money.transform(BigInt),
  listedDate: eventDate,
  expectedShipping: optionalMoney,
  expectedFeeSource: z.enum(["RATE", "AMOUNT", "UNKNOWN"]).optional(),
  expectedFee: optionalMoney.optional(),
  expectedPacking: optionalMoney.optional(),
  expectedOther: optionalMoney.optional(),
  channelRevision: z.number().int().nonnegative().optional(),
  draftId: z.uuid().optional(),
  draftRevision: z.number().int().nonnegative().optional(),
});
export const completionRecordSchema = z
  .object({
    valuationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    valuationPosition: z.union([z.literal("LAST"), z.uuid()]).optional(),
    draftId: z.uuid().optional(),
    draftRevision: z.number().int().nonnegative().optional(),
    idempotencyKey: z.uuid(),
    context: workflowContextSchema,
    listingId: z.uuid(),
    revision: z.number().int().min(0),
    completedDate: eventDate,
    actualPrice: money.transform(BigInt),
    fee: optionalMoney,
    shipping: optionalMoney,
    packing: optionalMoney,
    other: optionalMoney,
    purchasedDate: z.union([eventDate, z.literal("")]),
    shippedDate: z.union([eventDate, z.literal("")]),
    shippingMethod: z.string().max(100),
    trackingNumber: z.string().max(100),
    externalOrderId: z.string().trim().max(200),
    memo: z.string().max(2000),
  })
  .refine(
    (v) =>
      (!v.purchasedDate || v.purchasedDate <= v.completedDate) &&
      (!v.shippedDate || v.shippedDate <= v.completedDate),
    "購入日・発送日は完了日以前にしてください。",
  );
export const listingEventSchema = z.object({
  legacyQuantity: z.number().int().min(0).optional(),
  externalReference: z.string().max(500).optional(),
  idempotencyKey: z.uuid(),
  context: workflowContextSchema,
  listingId: z.uuid(),
  revision: z.number().int().min(0),
  date: eventDate,
  event: z.enum(["PAUSE", "RESUME", "END", "RETURN_PENDING", "RETURN_RECEIVED", "MIGRATE"]),
  goodsInHand: z.boolean(),
  reason: z.string().trim().min(1).max(1000),
  dispositions: z
    .array(
      z.object({
        reservationId: z.uuid(),
        disposition: z.enum(["RESTOCK", "DEFECTIVE", "DISPOSED", "LOST"]),
      }),
    )
    .max(500)
    .default([]),
});
export const amountAmendSchema = z.object({
  idempotencyKey: z.uuid(),
  context: workflowContextSchema,
  orderId: z.uuid(),
  revision: z.number().int().min(0),
  date: eventDate,
  actualPrice: money.transform(BigInt),
  fee: optionalMoney,
  shipping: optionalMoney,
  packing: optionalMoney,
  other: optionalMoney,
  reason: z.string().trim().min(1, "訂正・補完の理由を入力してください。").max(1000),
});
export const priceRecordSchema = z.object({
  idempotencyKey: z.uuid(),
  context: workflowContextSchema,
  listingId: z.uuid(),
  revision: z.number().int().min(0),
  date: eventDate,
  price: money.transform(BigInt),
  reason: z.string().trim().min(1).max(1000),
});
export const refundRecordSchema = z
  .object({
    idempotencyKey: z.uuid(),
    context: workflowContextSchema,
    orderId: z.uuid(),
    revision: z.number().int().min(0),
    date: eventDate,
    salesRefund: money.transform(BigInt),
    feeRefund: money.transform(BigInt),
    shippingRefund: money.transform(BigInt),
    reason: z.string().trim().min(1).max(1000),
  })
  .refine(
    (v) => v.salesRefund > 0n || v.feeRefund > 0n || v.shippingRefund > 0n,
    "返金・返還額を1つ以上入力してください。",
  );

// Local parsing only. An unrecognised URL must never be fetched by the server.
export function mercariReference(value: string): { id: string; url: string } {
  let id = value.trim();
  if (/^https?:\/\//i.test(id)) {
    const url = new URL(id);
    const match = url.pathname.match(/^\/item\/(m\d+)\/?$/);
    if (url.protocol !== "https:" || url.hostname !== "jp.mercari.com" || !match)
      throw new Error(
        "URLから商品IDを判別できません。メルカリの商品ID（mで始まる数字）を入力してください。",
      );
    id = match[1]!;
  }
  if (!/^m\d{5,30}$/.test(id))
    throw new Error("メルカリの商品ID（mで始まる数字）を確認してください。");
  return { id, url: `https://jp.mercari.com/item/${id}` };
}

export function confirmedProfit(input: {
  revenue: bigint;
  discount?: bigint;
  costs: Array<bigint | null>;
  cogs: bigint | null;
  finalCost: boolean;
}): bigint | null {
  if (!input.finalCost || input.cogs === null || input.costs.some((v) => v === null)) return null;
  return (
    input.revenue -
    (input.discount ?? 0n) -
    input.cogs -
    input.costs.reduce<bigint>((sum, value) => sum + value!, 0n)
  );
}
