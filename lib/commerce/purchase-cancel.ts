import type { PrismaClient } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { effectiveCosts } from "@/lib/inventory/effective-cost";
import { effectiveOperationTimeline } from "@/lib/inventory/event-dates";
import { averageUnitCost } from "@/lib/inventory/money";
import { plannedOperationOrder, plannedMovementCost } from "@/lib/inventory/valuation-session";
import { Precise } from "./allocation";
import { buyCancelSchema } from "./input";
function invalid(message: string): never {
  throw new WorkflowError("VALIDATION", message);
}
export async function cancelPurchase(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = buyCancelSchema.parse(raw);
  return runWorkflow(db, c, input, "BUY_CANCEL", input.date, async (tx) => {
    const p = await tx.purchaseDocument.findFirst({
      where: {
        id: input.purchaseId,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        reportingEntityId: c.reportingEntityId,
      },
      include: {
        lines: {
          include: {
            deliveries: true,
            receipts: {
              include: { receipt: true, inventoryLot: { include: { uniqueStockUnits: true } } },
            },
          },
        },
        charges: true,
      },
    });
    if (!p || p.revision !== input.revision || p.status === "CANCELLED")
      throw new WorkflowError(
        "CONFLICT",
        "購入が更新されています。入力を保持して確認してください。",
      );
    if (
      p.purchasedDate.toISOString().slice(0, 4) !== String(c.year) ||
      p.purchasedDate > new Date(`${input.date}T00:00:00Z`)
    )
      invalid("元の購入年度で、購入日以降の取消日を指定してください。");
    if (p.lines.some((l) => l.deliveries.length))
      invalid("配送が記録されています。実際の返送・返金は購入詳細から記録してください。");
    if (
      await tx.moneyTransaction.count({
        where: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          sourceId: { in: [p.id, ...p.charges.map((ch) => ch.id)] },
          reversedBy: null,
          reversesId: null,
        },
      })
    )
      invalid("入出金が記録されています。誤った入出金は先に取り消してください。");
    if (
      (await tx.materialUse.count({
        where: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          purchaseLineId: { in: p.lines.map((l) => l.id) },
        },
      })) ||
      (await tx.otherRecord.count({
        where: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          sourcePurchaseId: p.id,
          reversesId: null,
          reversedBy: null,
        },
      }))
    )
      invalid("この購入に関連する使用・収支の記録があります。履歴を確認してください。");
    const receipts = p.lines.flatMap((l) => l.receipts),
      lots = receipts.flatMap((r) => (r.inventoryLot ? [r.inventoryLot] : [])),
      lotIds = lots.map((l) => l.id);
    if (
      lots.some((l) => l.remainingQuantity !== l.receivedQuantity) ||
      lots.some((l) => l.uniqueStockUnits.some((u) => u.status !== "IN_STOCK"))
    )
      invalid("使用済みの在庫があります。取消ではなく返送・原価訂正を記録してください。");
    const moves = await tx.stockMovement.findMany({
      where: { inventoryLotId: { in: lotIds }, businessUnitId: c.businessUnitId },
      include: { operation: true },
    });
    if (
      moves.some((m) => m.movementType !== "RECEIPT") ||
      (await tx.inventoryReservation.count({
        where: { inventoryLotId: { in: lotIds }, status: "RESERVED" },
      }))
    )
      invalid("移動・販売・確保済みの在庫があります。履歴を確認してください。");
    const timeline = await effectiveOperationTimeline(
      tx,
      moves.map((m) => m.operation),
    );
    if ([...timeline.values()].some((r) => r.date > input.date))
      invalid("取消日は受取日以降を指定してください。");
    const outgoing = await tx.stockMovement.findMany({
        where: {
          businessUnitId: c.businessUnitId,
          itemVariantId: { in: lots.map((l) => l.itemVariantId) },
          quantity: { lt: 0 },
        },
        include: { operation: true },
      }),
      outDates = await effectiveOperationTimeline(
        tx,
        outgoing.map((m) => m.operation),
      );
    for (const out of outgoing)
      for (const receipt of moves.filter((m) => m.itemVariantId === out.itemVariantId)) {
        const a = outDates.get(out.operationId)!,
          b = timeline.get(receipt.operationId)!;
        if (a.date > b.date || (a.date === b.date && new Precise(a.order).gte(b.order)))
          invalid(
            "受取後に同じ商品の出庫があります。販売への影響があるため、原価訂正・返送で処理してください。",
          );
      }
    const costs = await effectiveCosts(tx, "MOVEMENT", moves);
    if (moves.length) {
      const operation = await tx.inventoryOperation.create({
        data: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          operationType: "PURCHASE_REVERSAL",
          sourceType: "purchase_document",
          sourceId: p.id,
          occurredAt: new Date(`${input.date}T00:00:00+09:00`),
          valuationOrder: plannedOperationOrder(),
          idempotencyKey: input.idempotencyKey,
        },
      });
      for (const [i, m] of moves.entries()) {
        const key = `${input.idempotencyKey}:${i}`,
          cost = -plannedMovementCost(key, -costs.get(m.id)!);
        await tx.stockMovement.create({
          data: {
            operationId: operation.id,
            itemVariantId: m.itemVariantId,
            inventoryLotId: m.inventoryLotId,
            uniqueStockUnitId: m.uniqueStockUnitId,
            movementType: "RECEIPT_REVERSAL",
            quantity: -m.quantity,
            costTotalJpy: -cost,
            movementAt: new Date(`${input.date}T00:00:00+09:00`),
            businessUnitId: c.businessUnitId,
            storageLocationFromId: m.storageLocationToId,
            sourceType: "purchase_document",
            sourceId: p.id,
            idempotencyKey: key,
            operatorId: c.operatorId,
          },
        });
        const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
          where: {
            itemVariantId_businessUnitId_trackingMode: {
              itemVariantId: m.itemVariantId,
              businessUnitId: c.businessUnitId,
              trackingMode: m.uniqueStockUnitId ? "UNIQUE" : "QUANTITY",
            },
          },
        });
        const quantity = balance.quantity - m.quantity,
          remaining = balance.carryingCostTotalJpy - cost;
        if (quantity < 0 || remaining < 0n) invalid("取消後の原価残高を照合できません。");
        await tx.inventoryCostBalance.update({
          where: { id: balance.id },
          data: {
            quantity,
            carryingCostTotalJpy: remaining,
            averageUnitCostJpy: quantity ? averageUnitCost(remaining, quantity) : "0",
          },
        });
        await tx.inventoryLot.update({
          where: { id: m.inventoryLotId! },
          data: { remainingQuantity: 0 },
        });
        if (m.uniqueStockUnitId)
          await tx.uniqueStockUnit.update({
            where: { id: m.uniqueStockUnitId },
            data: { status: "PURCHASE_CANCELLED" },
          });
      }
    }
    await tx.purchaseDocument.update({ where: { id: p.id }, data: { status: "CANCELLED" } });
    return {
      id: p.id,
      detail: {
        reason: input.reason,
        receivedQuantity: receipts.reduce((s, r) => s + r.quantity, 0),
      },
    };
  });
}
