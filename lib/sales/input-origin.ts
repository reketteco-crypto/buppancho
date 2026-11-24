import { z } from "zod";
import { WorkflowError } from "@/lib/sales/workflow-errors";
export const inputOriginSchema = z.object({
  type: z.literal("INPUT_ORIGIN"),
  reportingEntityId: z.uuid(),
  businessUnitId: z.uuid(),
  operatorId: z.uuid(),
  year: z.number().int(),
});
export type InputOrigin = z.infer<typeof inputOriginSchema>;
export function assertInputOrigin(
  value: unknown,
  context: { reportingEntityId: string; businessUnitId: string; operatorId: string; year: number },
) {
  const original = inputOriginSchema.safeParse(value);
  if (!original.success) return;
  if (original.data.reportingEntityId !== context.reportingEntityId)
    throw new WorkflowError(
      "OWNERSHIP_CHANGED",
      "入力開始後に申告主体が変更されています。手元の入力を保持し、元の帰属を確認してください。",
    );
  if (
    original.data.businessUnitId !== context.businessUnitId ||
    original.data.operatorId !== context.operatorId ||
    original.data.year !== context.year
  )
    throw new WorkflowError(
      "CONTEXT_CHANGED",
      "入力開始時と入力先が異なります。元の入力者・部門・年度へ戻してください。",
    );
}
