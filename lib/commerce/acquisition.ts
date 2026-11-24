import type { Prisma } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { effectiveLotReceiptDates } from "@/lib/inventory/event-dates";

import { receiptPlan } from "./receipt-delivery";

type Tx = Prisma.TransactionClient;
export async function receiptCurrentCosts(
  tx: Tx,
  c: WorkflowContext,
  rows: { id: string; costJpy: bigint }[],
) {
  const values = new Map(rows.map((r) => [r.id, r.costJpy]));
  const corrections = await tx.receiptCostCorrection.findMany({
    where: {
      receiptLineId: { in: rows.map((r) => r.id) },
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
    },
    orderBy: { sequence: "asc" },
  });
  for (const correction of corrections) values.set(correction.receiptLineId, correction.afterJpy);
  return values;
}

async function assertCostYear(tx: Tx, c: WorkflowContext, date: string) {
  const assignment = await tx.businessUnitAssignment.findFirst({
    where: {
      businessUnitId: c.businessUnitId,
      effectiveFrom: { lte: new Date(`${date}T00:00:00Z`) },
      effectiveTo: { gte: new Date(`${date}T00:00:00Z`) },
      fiscalYearProfile: { reportingEntityId: c.reportingEntityId, year: Number(date.slice(0, 4)) },
    },
    include: { fiscalYearProfile: true },
  });
  if (!assignment)
    throw new WorkflowError("OWNERSHIP_CHANGED", "原価を訂正する期間の帰属を確認できません。");
  await tx.$queryRaw`SELECT id FROM fiscal_year_profile WHERE id=${assignment.fiscalYearProfile.id}::uuid FOR SHARE`;
  const profile = await tx.fiscalYearProfile.findUniqueOrThrow({
    where: { id: assignment.fiscalYearProfile.id },
  });
  if (profile.status === "LOCKED")
    throw new WorkflowError("YEAR_LOCKED", `${profile.year}年度の原価はロックされています。`);
}

export async function refreshDocumentCostStates(tx: Tx, c: WorkflowContext, documentIds: string[]) {
  const documents = await tx.purchaseDocument.findMany({
    where: {
      id: { in: documentIds },
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
    },
    include: { lines: { select: { id: true } } },
  });
  const charges = await tx.purchaseCharge.findMany({
    where: {
      supersededBy: null,
      OR: [
        { documentId: { in: documentIds } },
        {
          delivery: {
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            lines: { some: { purchaseLine: { documentId: { in: documentIds } } } },
          },
        },
      ],
    },
    include: {
      allocations: { include: { line: { select: { documentId: true } } } },
      delivery: { include: { lines: { select: { purchaseLineId: true } } } },
    },
  });
  for (const document of documents) {
    const ids = document.lines.map((l) => l.id);
    const relevant = charges.filter((ch) => {
      if (ch.documentId === document.id) return true;
      const snapshot = ch.basisSnapshot as { targets?: string[] } | null;
      return (snapshot?.targets ?? ch.delivery?.lines.map((l) => l.purchaseLineId) ?? []).some(
        (id) => ids.includes(id),
      );
    });
    await tx.purchaseDocument.update({
      where: { id: document.id },
      data: { costFinal: relevant.every((ch) => ch.allocated) },
    });
  }
}

/** Change effective acquisition cost by appending corrections to original receipts. */
export async function reviseAcquisitionCosts(
  tx: Tx,
  c: WorkflowContext,
  key: string,
  lineIds: string[],
  reason: string,
) {
  const lines = await tx.purchaseDocumentLine.findMany({
    where: {
      id: { in: lineIds },
      document: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        reportingEntityId: c.reportingEntityId,
      },
    },
    include: {
      document: true,
      receipts: {
        include: { receipt: true, inventoryLot: { include: { uniqueStockUnits: true } } },
      },
    },
  });
  if (lines.length !== new Set(lineIds).size)
    throw new WorkflowError("OWNERSHIP_CHANGED", "原価の対象商品を確認できません。");
  const allReceipts = lines.flatMap((l) => l.receipts),
    current = await receiptCurrentCosts(tx, c, allReceipts);
  const receiptDates = await effectiveLotReceiptDates(
    tx,
    allReceipts.flatMap((r) => (r.inventoryLotId ? [r.inventoryLotId] : [])),
  );
  const changes: { receiptLineId: string; before: string; after: string }[] = [];
  for (const line of lines) {
    const receipts = [...line.receipts].sort(
      (a, b) =>
        a.receipt.receivedDate.getTime() - b.receipt.receivedDate.getTime() ||
        a.receipt.createdAt.getTime() - b.receipt.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    const plan = await receiptPlan(tx, line.id);
    for (const r of receipts) {
      const amount = plan.get(r.id)!;
      if (amount < 0n) throw new WorkflowError("VALIDATION", "訂正後の受取原価が0円を下回ります。");
      if (!r.inventoryLotId || !r.inventoryLot) continue;
      if (!reason.trim())
        throw new WorkflowError(
          "VALIDATION",
          "入庫済み商品の原価を訂正する理由を入力してください。",
        );
      const date = receiptDates.get(r.inventoryLotId);
      if (!date) throw new WorkflowError("HISTORY_INCOMPLETE", "元の受取履歴を確認できません。");
      await assertCostYear(tx, c, date);
      const movement = await tx.stockMovement.findFirst({
        where: {
          inventoryLotId: r.inventoryLotId,
          businessUnitId: c.businessUnitId,
          movementType: "RECEIPT",
        },
      });
      if (!movement || !r.receipt.operationId)
        throw new WorkflowError("HISTORY_INCOMPLETE", "原価訂正の元になる入庫を確認できません。");
      const before = current.get(r.id)!;
      if (before !== amount)
        await tx.receiptCostCorrection.create({
          data: {
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            receiptLineId: r.id,
            movementId: movement.id,
            operationId: r.receipt.operationId,
            requestId: key,
            beforeJpy: before,
            afterJpy: amount,
            reason,
          },
        });
      await tx.inventoryLot.update({
        where: { id: r.inventoryLotId },
        data: { costStatus: line.document.costFinal ? "FINAL" : "PROVISIONAL" },
      });
      for (const unit of r.inventoryLot.uniqueStockUnits)
        await tx.uniqueStockUnit.update({
          where: { id: unit.id },
          data: { acquisitionCostJpy: amount },
        });
      if (before !== amount)
        changes.push({ receiptLineId: r.id, before: before.toString(), after: amount.toString() });
    }
  }
  if (changes.length)
    await tx.inventoryRevision.upsert({
      where: { businessUnitId: c.businessUnitId },
      create: { businessUnitId: c.businessUnitId, revision: 1n },
      update: { revision: { increment: 1 } },
    });
  const lotIds = allReceipts.flatMap((r) => (r.inventoryLotId ? [r.inventoryLotId] : []));
  const orders = await tx.salesOrder.findMany({
    where: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      lines: {
        some: {
          consumptions: {
            some: {
              OR: [
                { inventoryLotId: { in: lotIds } },
                { uniqueStockUnit: { inventoryLotId: { in: lotIds } } },
              ],
            },
          },
        },
      },
    },
    include: {
      lines: {
        include: {
          consumptions: {
            include: { inventoryLot: true, uniqueStockUnit: { include: { inventoryLot: true } } },
          },
        },
      },
    },
  });
  for (const order of orders) {
    if (order.reportingEntityId !== c.reportingEntityId)
      throw new WorkflowError("OWNERSHIP_CHANGED", "別の申告主体の販売に影響します。");
    const final = order.lines.every(
      (l) =>
        l.consumptions.length > 0 &&
        l.consumptions.every(
          (r) => (r.inventoryLot ?? r.uniqueStockUnit?.inventoryLot)?.costStatus === "FINAL",
        ),
    );
    if ((order.costStatus === "FINAL") !== final) {
      if (order.completedAt)
        await assertCostYear(
          tx,
          c,
          order.completedAt.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
        );
      await tx.salesOrder.update({
        where: { id: order.id },
        data: { costStatus: final ? "FINAL" : "PROVISIONAL", revision: { increment: 1 } },
      });
    }
  }
  return changes;
}
