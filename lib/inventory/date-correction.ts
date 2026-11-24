import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { eventDate, workflowContextSchema, valuationFields } from "@/lib/validation/workflow";
import {
  effectiveOperationDates,
  effectiveSourceDates,
  eventDay,
} from "@/lib/inventory/event-dates";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { historicalPreviewAllowed, plannedOperationOrder } from "@/lib/inventory/valuation-session";
export const dateCorrectionSchema = z.object({
  ...valuationFields,
  idempotencyKey: z.uuid(),
  context: workflowContextSchema,
  operationId: z.uuid(),
  previousDate: eventDate,
  date: eventDate,
  reason: z.string().trim().min(1, "訂正理由を入力してください。").max(1000),
});
export async function recordDateCorrection(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof dateCorrectionSchema>,
) {
  return runWorkflow(db, c, input, "DATE_CORRECT", input.date, async (tx) => {
    const op = await tx.inventoryOperation.findFirst({
      where: {
        id: input.operationId,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
      },
      include: { _count: { select: { movements: true } } },
    });
    if (!op) throw new WorkflowError("CONTEXT_CHANGED", "訂正対象の部門・記録を確認できません。");
    const observation = await tx.stocktakeObservation.findFirst({
      where: { operationId: op.id, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
    });
    if (observation && observation.reportingEntityId !== c.reportingEntityId)
      throw new WorkflowError("OWNERSHIP_CHANGED", "元の実測記録の申告主体が異なります。");
    if (!op._count.movements && !observation)
      throw new WorkflowError("HISTORY_INCOMPLETE", "訂正する在庫移動を確認できません。");
    const previous = (await effectiveOperationDates(tx, [op])).get(op.id)!;
    if (previous !== input.previousDate)
      throw new WorkflowError(
        "CONFLICT",
        "日付が別操作で訂正されました。入力を保持し、現在の日付を確認してください。",
      );
    if (previous === input.date)
      throw new WorkflowError("VALIDATION", "訂正後の日付が変わっていません。");
    if (previous.slice(0, 4) !== String(c.year) || input.date.slice(0, 4) !== String(c.year))
      throw new WorkflowError("CONTEXT_CHANGED", "日付訂正は同じ未ロック年度内だけで行えます。");
    const genericDocumentIds = new Set<string>();
    if (op.sourceType === "purchase_receipt") {
      const receipt = await tx.purchaseReceipt.findFirst({
        where: { operationId: op.id, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        include: {
          lines: {
            include: {
              line: { include: { document: true } },
              deliveryLine: { include: { delivery: true } },
              deliveryLinks: { include: { deliveryLine: { include: { delivery: true } } } },
              supplierReturns: true,
            },
          },
        },
      });
      if (!receipt) throw new WorkflowError("HISTORY_INCOMPLETE", "元の受取を確認できません。");
      if (receipt.reportingEntityId !== c.reportingEntityId)
        throw new WorkflowError("OWNERSHIP_CHANGED", "受取時の帰属が異なります。");
      for (const row of receipt.lines) {
        genericDocumentIds.add(row.line.documentId);
        if (row.line.document.status === "CANCELLED")
          throw new WorkflowError("VALIDATION", "取消済み購入の受取日は訂正できません。");
        const dates = [
          row.line.document.purchasedDate,
          ...(row.deliveryLine ? [row.deliveryLine.delivery.shippedDate] : []),
          ...row.deliveryLinks.map((l) => l.deliveryLine.delivery.shippedDate),
        ];
        if (dates.some((date) => date.toISOString().slice(0, 10) > input.date))
          throw new WorkflowError("VALIDATION", "受取日は購入日・配送日以降にしてください。", {
            fields: { date: "購入と配送の日付を確認してください。" },
          });
        const operations = await tx.inventoryOperation.findMany({
            where: {
              id: { in: row.supplierReturns.map((r) => r.operationId) },
              workspaceId: c.workspaceId,
              businessUnitId: c.businessUnitId,
            },
          }),
          returns = await effectiveOperationDates(tx, operations);
        if ([...returns.values()].some((date) => date < input.date))
          throw new WorkflowError("VALIDATION", "取引先への返送日より後に受取日を変更できません。");
      }
    }
    if (op.sourceType === "purchase_return") {
      const returned = await tx.supplierReturn.findFirst({
        where: {
          operationId: op.id,
          receiptLine: {
            receipt: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
          },
        },
        include: { receiptLine: { include: { receipt: true, line: true } } },
      });
      if (!returned || returned.receiptLine.receipt.reportingEntityId !== c.reportingEntityId)
        throw new WorkflowError("OWNERSHIP_CHANGED", "元の返送と帰属を確認できません。");
      const source = await tx.inventoryOperation.findFirst({
        where: {
          id: returned.receiptLine.receipt.operationId!,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
        },
      });
      if (!source || (await effectiveOperationDates(tx, [source])).get(source.id)! > input.date)
        throw new WorkflowError("VALIDATION", "返送日は受取日以降にしてください。");
      genericDocumentIds.add(returned.receiptLine.line.documentId);
    }
    if (op.sourceType === "purchase_document") {
      const document = await tx.purchaseDocument.findFirst({
        where: {
          id: op.sourceId,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          reportingEntityId: c.reportingEntityId,
        },
        include: { lines: { include: { receipts: { include: { receipt: true } } } } },
      });
      if (!document)
        throw new WorkflowError("OWNERSHIP_CHANGED", "元の購入と帰属を確認できません。");
      const operations = await tx.inventoryOperation.findMany({
          where: {
            id: {
              in: document.lines.flatMap((l) =>
                l.receipts.flatMap((r) => (r.receipt.operationId ? [r.receipt.operationId] : [])),
              ),
            },
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
          },
        }),
        dates = await effectiveOperationDates(tx, operations);
      if ([...dates.values()].some((date) => date > input.date))
        throw new WorkflowError("VALIDATION", "取消日は受取日以降にしてください。");
      genericDocumentIds.add(document.id);
    }
    if (op.sourceType === "purchase") {
      const purchase = await tx.purchase.findFirst({
        where: { id: op.sourceId, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      });
      if (!purchase) throw new WorkflowError("HISTORY_INCOMPLETE", "元の仕入れを照合できません。");
      if (purchase.reportingEntityId !== c.reportingEntityId)
        throw new WorkflowError("OWNERSHIP_CHANGED", "元の仕入れの申告主体が異なります。");
      if (input.date < purchase.purchasedDate.toISOString().slice(0, 10))
        throw new WorkflowError("VALIDATION", "入庫・取消日は仕入日以降を指定してください。", {
          fields: { date: "仕入日より前には訂正できません。" },
        });
      const siblings = await tx.inventoryOperation.findMany({
        where: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          sourceType: "purchase",
          sourceId: op.sourceId,
        },
      });
      const dates = await effectiveOperationDates(tx, siblings);
      dates.set(op.id, input.date);
      const receipt = siblings.find((o) => o.operationType === "PURCHASE_RECEIPT");
      const reversal = siblings.find((o) => o.operationType === "PURCHASE_REVERSAL");
      if (receipt && reversal && dates.get(receipt.id)! > dates.get(reversal.id)!)
        throw new WorkflowError("VALIDATION", "仕入取消日は入庫日以降にする必要があります。", {
          fields: { date: "入庫と取消の前後関係を確認してください。" },
        });
    }
    if (op.sourceType === "sales_order" && op.operationType === "SALE_COMPLETION") {
      const order = await tx.salesOrder.findFirst({
        where: { id: op.sourceId, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        include: { completionListing: true, returns: true },
      });
      if (!order) throw new WorkflowError("HISTORY_INCOMPLETE", "元の完了実績を照合できません。");
      if (order.reportingEntityId !== c.reportingEntityId)
        throw new WorkflowError("OWNERSHIP_CHANGED", "元の完了実績の申告主体が異なります。");
      if (
        order.completionListing?.listedAt &&
        input.date < eventDay(order.completionListing.listedAt)
      )
        throw new WorkflowError("VALIDATION", "完了日は出品日以降にしてください。", {
          fields: { date: "出品日より前には訂正できません。" },
        });
      if (
        order.recordingMode === "DIRECT" &&
        (await tx.materialUse.count({
          where: {
            saleId: order.id,
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            requestId: { not: order.requestKey! },
            supersededBy: null,
            date: { lt: new Date(input.date) },
          },
        }))
      )
        throw new WorkflowError("VALIDATION", "資材の追加使用日より後に完了日を変更できません。");
      const dates = await effectiveSourceDates(
        tx,
        { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        "sales_return",
        order.returns.map((r) => ({ id: r.id, date: r.returnedAt })),
      );
      if ([...dates.values()].some((d) => d < input.date))
        throw new WorkflowError("VALIDATION", "返品・返金日より後に完了日を変更できません。", {
          fields: { date: "既存の返品・返金との前後関係を確認してください。" },
        });
    }
    if (op.sourceType === "listing") {
      const handling = await tx.listingReturnHandling.findFirst({ where: { operationId: op.id } });
      if (handling) {
        const member = await tx.listingReturnMember.findUniqueOrThrow({
          where: { id: handling.memberId },
        });
        const returnCase = await tx.listingReturnCase.findFirst({
          where: {
            id: member.caseId,
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
          },
        });
        if (!returnCase || returnCase.reportingEntityId !== c.reportingEntityId)
          throw new WorkflowError("OWNERSHIP_CHANGED", "返送案件の帰属を確認できません。");
        if (input.date < returnCase.startedDate.toISOString().slice(0, 10))
          throw new WorkflowError("VALIDATION", "返送確認日は返送待ちの記録日以降にしてください。");
        const closes = await tx.workflowEvent.findMany({
          where: {
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            targetId: returnCase.listingId,
            kind: "LISTING_RETURN_CLOSE",
          },
        });
        if (
          closes.some(
            (e) =>
              (e.detail as { result?: { caseId?: string } }).result?.caseId === returnCase.id &&
              input.date > eventDay(e.occurredAt),
          )
        )
          throw new WorkflowError("VALIDATION", "案件を閉じた日より後へ確認日を訂正できません。");
      }
    }
    if (op.sourceType === "sales_return") {
      const parent = await tx.salesReturn.findFirst({
        where: {
          id: op.sourceId,
          salesOrder: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        },
        include: { salesOrder: true },
      });
      if (!parent?.salesOrder.completedAt)
        throw new WorkflowError("HISTORY_INCOMPLETE", "返品元の完了実績を照合できません。");
      if (parent.salesOrder.reportingEntityId !== c.reportingEntityId)
        throw new WorkflowError("OWNERSHIP_CHANGED", "元の完了実績の申告主体が異なります。");
      const dates = await effectiveSourceDates(
        tx,
        { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        "sales_order",
        [{ id: parent.salesOrderId, date: parent.salesOrder.completedAt }],
      );
      if (input.date < dates.get(parent.salesOrderId)!)
        throw new WorkflowError("VALIDATION", "返品日は元取引の完了日以降にしてください。", {
          fields: { date: "完了日より前には訂正できません。" },
        });
    }
    if (!input.valuationFingerprint && !historicalPreviewAllowed())
      throw new WorkflowError(
        "VALUATION_REQUIRED",
        "日付訂正の在庫・原価への影響を確認してください。",
      );
    const correction = await tx.eventDateCorrection.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operationId: op.id,
        requestId: input.idempotencyKey,
        previousDate: new Date(previous),
        effectiveDate: new Date(input.date),
        valuationOrder: plannedOperationOrder(),
        reason: input.reason,
        operatorId: c.operatorId,
      },
    });
    await tx.inventoryRevision.upsert({
      where: { businessUnitId: c.businessUnitId },
      create: { businessUnitId: c.businessUnitId, revision: 1n },
      update: { revision: { increment: 1n } },
    });
    if (op.operationType === "SALE_COMPLETION")
      await tx.salesOrder.updateMany({
        where: { id: op.sourceId, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        data: { revision: { increment: 1 } },
      });
    if (op.sourceType === "purchase")
      await tx.purchase.updateMany({
        where: { id: op.sourceId, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        data: { revision: { increment: 1 } },
      });
    for (const id of genericDocumentIds)
      await tx.purchaseDocument.updateMany({
        where: {
          id,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          reportingEntityId: c.reportingEntityId,
        },
        data: { revision: { increment: 1 } },
      });
    if (op.sourceType === "sales_return") {
      const parent = await tx.salesReturn.findFirst({
        where: {
          id: op.sourceId,
          salesOrder: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        },
      });
      if (parent)
        await tx.salesOrder.update({
          where: { id: parent.salesOrderId },
          data: { revision: { increment: 1 } },
        });
    }
    return {
      id: correction.id,
      detail: {
        operationId: op.id,
        previousDate: previous,
        date: input.date,
        reason: input.reason,
      },
    };
  });
}
