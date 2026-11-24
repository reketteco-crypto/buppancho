import { z } from "zod";
import { eventDate } from "@/lib/validation/workflow";

const text = z.string().max(2000);
const identifier = z.union([z.uuid(), z.literal("")]);
export const salesBatchRowSchema = z.object({
  id: z.uuid(),
  selected: z.boolean(),
  excluded: z.boolean(),
  completed: z.boolean(),
  sourceName: text,
  source: z
    .object({
      file: text,
      purchasedAt: text,
      updatedAt: text,
      url: text,
      profit: text,
      amount: text.optional(),
      fee: text.optional(),
      shipping: text.optional(),
    })
    .optional(),
  skuId: identifier,
  channelId: identifier,
  deliveryMethodId: identifier,
  date: z.union([eventDate, z.literal("")]),
  quantity: z.number().int().min(0).max(1000000),
  price: z.string().max(32),
  priceBasis: z.enum(["UNIT", "TOTAL"]).default("UNIT"),
  fee: z.string().max(32),
  shipping: z.string().max(32),
  externalId: z.string().max(150),
  buyer: z.string().max(150),
  memo: text,
  position: z.union([z.literal(""), z.literal("LAST"), z.uuid()]),
  supplyQuantities: z.record(z.uuid(), z.string().max(32)).optional(),
  targetId: z.uuid().optional(),
});
export const salesBatchDataSchema = z.object({
  rows: z
    .array(salesBatchRowSchema)
    .max(5000)
    .refine(
      (rows) => new Set(rows.map((r) => r.id)).size === rows.length,
      "行IDが重複しています。",
    ),
});
export type SalesBatchRow = z.infer<typeof salesBatchRowSchema>;
export type SalesBatchData = z.infer<typeof salesBatchDataSchema>;
export const salesBatchChangesSchema = z.object({
  changedRows: z
    .array(salesBatchRowSchema)
    .max(5000)
    .refine(
      (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      "変更行IDが重複しています。",
    ),
});
export type SalesBatchChanges = z.infer<typeof salesBatchChangesSchema>;
export type SalesBatchMapping = { sourceName: string; channelId: string; skuId: string };
export type SalesBatchPreviewRow = {
  rowId: string;
  name: string;
  date: string;
  cost: string;
  materials: string | null;
  profit: string | null;
  provisional: boolean;
  balances: {
    variantId: string;
    trackingMode: string;
    quantity: number;
    before: string;
    after: string;
  }[];
  impacts: {
    name: string;
    date: string;
    beforeCost: string | null;
    afterCost: string | null;
    beforeProfit: string | null;
    afterProfit: string | null;
  }[];
};
export type SalesBatchIssue = {
  rowId: string;
  message: string;
  choices?: { id: string; label: string }[];
};
export type SalesBatchReview = {
  id?: string;
  rows: SalesBatchPreviewRow[];
  issues: SalesBatchIssue[];
};
export function emptySalesBatchRow(id: string): SalesBatchRow {
  return {
    id,
    selected: false,
    excluded: false,
    completed: false,
    sourceName: "",
    skuId: "",
    channelId: "",
    deliveryMethodId: "",
    date: "",
    quantity: 1,
    price: "",
    priceBasis: "UNIT",
    fee: "",
    shipping: "",
    externalId: "",
    buyer: "",
    memo: "",
    position: "",
  };
}
