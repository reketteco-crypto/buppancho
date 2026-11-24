import type { PrismaClient } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { categorySchema, otherRecordSchema, moneySchema } from "./input";
import { executeMoney } from "./money";
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
  reportingEntityId: c.reportingEntityId,
});
export async function recordOther(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = otherRecordSchema.parse(raw);
  return runWorkflow(db, c, input, "OTHER_RECORD", input.date, async (tx) => {
    if (
      input.sourceSaleId &&
      !(await tx.salesOrder.findFirst({ where: { id: input.sourceSaleId, ...scope(c) } }))
    )
      throw new WorkflowError("VALIDATION", "関連する販売を確認してください。");
    if (
      input.sourcePurchaseId &&
      !(await tx.purchaseDocument.findFirst({ where: { id: input.sourcePurchaseId, ...scope(c) } }))
    )
      throw new WorkflowError("VALIDATION", "関連する購入を確認してください。");
    const original = input.reversesId
      ? await tx.otherRecord.findFirst({
          where: { id: input.reversesId, ...scope(c), reversedBy: null, reversesId: null },
        })
      : null;
    if (
      input.reversesId &&
      (!original || !input.memo || original.date > new Date(`${input.date}T00:00:00Z`))
    )
      throw new WorkflowError("CONFLICT", "取消対象の日付と理由を確認してください。");
    let category = original
      ? await tx.moneyCategory.findFirst({
          where: { id: original.categoryId, workspaceId: c.workspaceId },
        })
      : input.categoryId
        ? await tx.moneyCategory.findFirst({
            where: {
              id: input.categoryId,
              workspaceId: c.workspaceId,
              kind: input.kind,
              active: true,
            },
          })
        : await tx.moneyCategory.findFirst({
            where: { workspaceId: c.workspaceId, kind: input.kind, name: input.categoryName },
          });
    if (
      !original &&
      ((input.categoryId && !category) ||
        (category &&
          (!category.active ||
            (input.categoryRevision !== undefined &&
              category.revision !== input.categoryRevision))))
    )
      throw new WorkflowError("CONFLICT", "収支項目が更新されました。確認してください。");
    category ??= await tx.moneyCategory.create({
      data: { workspaceId: c.workspaceId, kind: input.kind, name: input.categoryName },
    });
    const r = await tx.otherRecord.create({
      data: {
        ...scope(c),
        date: new Date(`${input.date}T00:00:00Z`),
        kind: original?.kind ?? input.kind,
        categoryId: category.id,
        categoryName: original?.categoryName ?? category.name,
        amountJpy: original ? -original.amountJpy : BigInt(input.amount),
        sourceSaleId: original?.sourceSaleId ?? input.sourceSaleId,
        sourcePurchaseId: original?.sourcePurchaseId ?? input.sourcePurchaseId,
        counterparty: original?.counterparty ?? (input.counterparty || null),
        memo: input.memo || null,
        reversesId: original?.id,
        requestId: input.idempotencyKey,
      },
    });
    let settlementId: string | undefined;
    if (input.settled && r.amountJpy !== 0n) {
      const incoming = (r.kind === "INCOME") !== r.amountJpy < 0n;
      const result = await executeMoney(
        tx,
        c,
        moneySchema.parse({
          ...input,
          paymentMethod: input.paymentMethod,
          kind: incoming ? "OTHER_RECEIPT" : "OTHER_PAYMENT",
          sourceId: r.id,
          sourceRevision: 0,
          amount: (r.amountJpy < 0n ? -r.amountJpy : r.amountJpy).toString(),
        }),
      );
      settlementId = result.id;
    }
    return {
      id: r.id,
      detail: {
        kind: r.kind,
        amount: r.amountJpy.toString(),
        settlementId: typeof settlementId === "string" ? settlementId : null,
        reversesId: original?.id ?? null,
      },
    };
  });
}
export async function recordCategory(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = categorySchema.parse(raw);
  return runWorkflow(db, c, input, "CATEGORY_SAVE", input.date, async (tx) => {
    const previous = input.id
      ? await tx.moneyCategory.findFirst({ where: { id: input.id, workspaceId: c.workspaceId } })
      : null;
    if (
      input.id &&
      (!previous || previous.revision !== input.revision || previous.kind !== input.kind)
    )
      throw new WorkflowError("CONFLICT", "収支項目を再確認してください。");
    const duplicate = await tx.moneyCategory.findFirst({
      where: {
        workspaceId: c.workspaceId,
        name: input.name,
        kind: input.kind,
        id: { not: input.id || undefined },
      },
    });
    if (duplicate) throw new WorkflowError("VALIDATION", "同じ名前の項目があります。");
    const r = previous
      ? await tx.moneyCategory.update({
          where: { id: previous.id },
          data: { name: input.name, active: input.active },
        })
      : await tx.moneyCategory.create({
          data: { workspaceId: c.workspaceId, name: input.name, kind: input.kind },
        });
    return { id: r.id, detail: { name: r.name, kind: r.kind } };
  });
}
