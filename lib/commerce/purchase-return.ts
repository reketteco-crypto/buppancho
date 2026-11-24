import type { PrismaClient } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { lotLocations } from "@/lib/sales/workflow";
import { effectiveLotReceiptDates } from "@/lib/inventory/event-dates";
import { averageUnitCost, movingAverageOutCost } from "@/lib/inventory/money";
import { plannedMovementCost, plannedOperationOrder } from "@/lib/inventory/valuation-session";
import { purchaseReturnSchema } from "./input";
export async function recordPurchaseReturn(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = purchaseReturnSchema.parse(raw);
  return runWorkflow(db, c, input, "PURCHASE_RETURN", input.date, async (tx) => {
    const source = await tx.purchaseReceiptLine.findFirst({
      where: {
        id: input.receiptLineId,
        receipt: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          reportingEntityId: c.reportingEntityId,
        },
      },
      include: {
        line: { include: { document: true } },
        inventoryLot: { include: { uniqueStockUnits: true } },
        supplierReturns: true,
      },
    });
    if (!source || !source.inventoryLot || source.line.document.revision !== input.revision)
      throw new WorkflowError(
        "CONFLICT",
        "購入・在庫が更新されました。入力を保持して確認してください。",
      );
    const lot = source.inventoryLot,
      qty = input.quantity;
    const dates = await effectiveLotReceiptDates(tx, [lot.id]);
    if (
      !dates.has(lot.id) ||
      dates.get(lot.id)! > input.date ||
      qty > source.quantity - source.supplierReturns.reduce((s, r) => s + r.quantity, 0) ||
      qty > lot.remainingQuantity
    )
      throw new WorkflowError("VALIDATION", "返送日と返送できる数量を確認してください。");
    const unit = lot.trackingMode === "UNIQUE" ? lot.uniqueStockUnits[0] : undefined;
    if (unit && (qty !== 1 || unit.status !== "IN_STOCK"))
      throw new WorkflowError("VALIDATION", "この個体は返送できません。");
    const at = new Date(`${input.date}T00:00:00+09:00`);
    const operation = await tx.inventoryOperation.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        operationType: "PURCHASE_RETURN",
        sourceType: "purchase_return",
        sourceId: input.idempotencyKey,
        occurredAt: at,
        valuationOrder: plannedOperationOrder(),
        idempotencyKey: input.idempotencyKey,
      },
    });
    const result = await tx.supplierReturn.create({
      data: {
        receiptLineId: source.id,
        quantity: qty,
        refundJpy: input.refund === "" ? null : BigInt(input.refund),
        reason: input.reason,
        returnedDate: new Date(`${input.date}T00:00:00Z`),
        operationId: operation.id,
        requestId: input.idempotencyKey,
      },
    });
    const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
      where: {
        itemVariantId_businessUnitId_trackingMode: {
          itemVariantId: lot.itemVariantId,
          businessUnitId: c.businessUnitId,
          trackingMode: lot.trackingMode,
        },
      },
    });
    const fallback = unit
      ? unit.acquisitionCostJpy
      : movingAverageOutCost(balance.carryingCostTotalJpy, balance.quantity, qty);
    let left = qty,
      used = 0n,
      index = 0;
    for (const [locationId, count] of await lotLocations(tx, lot.id)) {
      const held = await tx.inventoryReservation.aggregate({
        where: { inventoryLotId: lot.id, storageLocationId: locationId, status: "RESERVED" },
        _sum: { quantity: true },
      });
      const take = Math.min(left, count - (held._sum.quantity || 0));
      if (take <= 0) continue;
      const key = `${input.idempotencyKey}:${index++}`,
        cost = -plannedMovementCost(
          key,
          -(take === left ? fallback - used : (fallback * BigInt(take)) / BigInt(qty)),
        );
      used += cost;
      left -= take;
      await tx.stockMovement.create({
        data: {
          operationId: operation.id,
          itemVariantId: lot.itemVariantId,
          inventoryLotId: lot.id,
          uniqueStockUnitId: unit?.id,
          movementType: "PURCHASE_RETURN",
          quantity: -take,
          costTotalJpy: -cost,
          movementAt: at,
          businessUnitId: c.businessUnitId,
          storageLocationFromId: locationId,
          sourceType: "supplier_return",
          sourceId: result.id,
          idempotencyKey: key,
          operatorId: c.operatorId,
        },
      });
      if (!left) break;
    }
    if (left) throw new WorkflowError("VALIDATION", "確保分を除く返送可能な在庫が不足しています。");
    await tx.inventoryLot.update({
      where: { id: lot.id },
      data: { remainingQuantity: { decrement: qty } },
    });
    if (unit)
      await tx.uniqueStockUnit.update({
        where: { id: unit.id },
        data: { status: "SUPPLIER_RETURNED" },
      });
    const remaining = balance.quantity - qty,
      cost = balance.carryingCostTotalJpy - used;
    await tx.inventoryCostBalance.update({
      where: { id: balance.id },
      data: {
        quantity: remaining,
        carryingCostTotalJpy: cost,
        averageUnitCostJpy: remaining ? averageUnitCost(cost, remaining) : "0",
      },
    });
    await tx.purchaseDocument.update({
      where: { id: source.line.documentId },
      data: { revision: { increment: 1 } },
    });
    return {
      id: source.line.documentId,
      detail: { returnId: result.id, quantity: qty, cost: used.toString(), refund: input.refund },
    };
  });
}
