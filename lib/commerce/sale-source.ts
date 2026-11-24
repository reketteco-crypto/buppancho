import { z } from "zod";

const sourceText = z.string().max(2000);
export const saleSourceSchema = z.object({
  batchId: z.uuid(),
  rowId: z.uuid(),
  sourceName: sourceText,
  file: sourceText.optional(),
  purchasedAt: sourceText.optional(),
  updatedAt: sourceText.optional(),
  url: sourceText.optional(),
  profit: sourceText.optional(),
  amount: sourceText.optional(),
  fee: sourceText.optional(),
  shipping: sourceText.optional(),
});
