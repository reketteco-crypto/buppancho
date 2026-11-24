import type { Prisma, PrismaClient, InventoryOperation } from "@/generated/prisma/client";
import type { z } from "zod";
import { averageUnitCost, movingAverageOutCost, parseYen } from "@/lib/inventory/money";
import { lockInventoryTarget } from "@/lib/inventory/context";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { hasLaterInventoryEvents, effectiveLotReceiptDates } from "@/lib/inventory/event-dates";
import type { inventoryRecordSchema } from "@/lib/validation/workflow";
import {
  historicalPreviewAllowed,
  plannedOperationOrder,
  plannedMovementCost,
  plannedOutCost,
} from "@/lib/inventory/valuation-session";

function locationBalances(
  movements: Array<{
    inventoryLotId: string | null;
    movementType: string;
    quantity: number;
    storageLocationFromId: string | null;
    storageLocationToId: string | null;
  }>,
  locationId: string,
) {
  const balances = new Map<string, number>();
  for (const row of movements) {
    if (!row.inventoryLotId) continue;
    if (["RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(row.movementType)) continue;
    let delta = 0;
    if (row.movementType === "LOCATION_TRANSFER") {
      if (row.storageLocationToId === locationId) delta += row.quantity;
      if (row.storageLocationFromId === locationId) delta -= row.quantity;
    } else {
      if (row.storageLocationToId === locationId) delta += row.quantity;
      if (row.storageLocationFromId === locationId) delta += row.quantity;
    }
    balances.set(row.inventoryLotId, (balances.get(row.inventoryLotId) ?? 0) + delta);
  }
  return balances;
}

export async function recordInventoryOperation(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof inventoryRecordSchema>,
) {
  return runWorkflow(db, c, input, "INVENTORY", input.occurredDate, (tx) =>
    executeInventoryOperation(tx, c, input),
  );
}
export async function executeInventoryOperation(
  tx: Prisma.TransactionClient,
  c: WorkflowContext,
  input: z.output<typeof inventoryRecordSchema>,
  existingOperation?: InventoryOperation,
) {
  const date = new Date(`${input.occurredDate}T00:00:00Z`);
  const version = await tx.inventoryRevision.findUnique({
    where: { businessUnitId: c.businessUnitId },
  });
  if (!existingOperation && (version?.revision ?? 0n).toString() !== input.inventoryRevision)
    throw new WorkflowError(
      "CONFLICT",
      "在庫が別操作で更新されました。入力を保持して最新の在庫を確認してください。",
    );
  const variant = await tx.itemVariant.findFirst({
    where: {
      id: input.variantId,
      active: true,
      inventoryItem: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        status: "ACTIVE",
      },
    },
    include: { inventoryItem: true },
  });
  if (!variant) throw new WorkflowError("VALIDATION", "対象商品が見つかりません。");
  const locationIds = [
    input.fromLocationId,
    input.toLocationId,
    ...(input.operationType === "ADJUSTMENT_IN" && !input.toLocationId
      ? [variant.inventoryItem.defaultStorageLocationId]
      : []),
  ].filter((id): id is string => !!id);
  const locationCount = await tx.storageLocation.count({
    where: {
      id: { in: locationIds },
      workspaceId: c.workspaceId,
      active: true,
      OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
    },
  });
  if (locationCount !== new Set(locationIds).size)
    throw new WorkflowError("VALIDATION", "保管場所を使用できません。");

  // Until the shared backdating preview is available, never apply a current cost to an earlier event.
  const later = await hasLaterInventoryEvents(tx, c, [input.variantId], input.occurredDate);
  if (later && !historicalPreviewAllowed())
    throw new WorkflowError(
      "VALUATION_REQUIRED",
      "指定日より後の在庫履歴があります。在庫操作の後日入力は原価影響確認の実装待ちです。現在原価では確定しません。",
    );
  await lockInventoryTarget(tx, variant.id, c.businessUnitId);
  const operation =
    existingOperation ??
    (await tx.inventoryOperation.create({
      data: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        operatorId: c.operatorId,
        operationType: input.operationType,
        sourceType: "manual_adjustment",
        sourceId: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey,
        occurredAt: new Date(`${input.occurredDate}T00:00:00+09:00`),
        valuationOrder: plannedOperationOrder(),
        note: `${input.reason}: ${input.note}`.trim(),
      },
    }));
  if (input.trackingMode === "UNIQUE") {
    if (!input.uniqueStockUnitId || input.quantity !== 1 || input.operationType === "ADJUSTMENT_IN")
      throw new WorkflowError("VALIDATION", "個体商品の操作内容を確認してください。");
    const unit = await tx.uniqueStockUnit.findFirst({
      where: {
        id: input.uniqueStockUnitId,
        workspaceId: c.workspaceId,
        itemVariantId: variant.id,
        status:
          input.operationType === "LOCATION_TRANSFER"
            ? { in: ["IN_STOCK", "RESERVED"] }
            : "IN_STOCK",
      },
    });
    if (!unit) throw new WorkflowError("VALIDATION", "在庫中の個体が見つかりません。");
    const sourceLot = await tx.inventoryLot.findUniqueOrThrow({
      where: { id: unit.inventoryLotId },
    });
    const receiptDates = await effectiveLotReceiptDates(tx, [sourceLot.id]);
    if (!receiptDates.has(sourceLot.id) || receiptDates.get(sourceLot.id)! > input.occurredDate)
      throw new WorkflowError(
        "HISTORY_INCOMPLETE",
        "実施日にまだ入庫していない個体です。日付を確認してください。",
      );
    if (input.fromLocationId && unit.storageLocationId !== input.fromLocationId)
      throw new WorkflowError("VALIDATION", "個体の現在場所が移動元と一致しません。");
    const isTransfer = input.operationType === "LOCATION_TRANSFER";
    if (isTransfer)
      await tx.inventoryReservation.updateMany({
        where: { uniqueStockUnitId: unit.id, status: "RESERVED" },
        data: { storageLocationId: input.toLocationId },
      });
    const movementType = input.operationType;
    const status =
      input.operationType === "DISPOSAL"
        ? "DISPOSED"
        : input.operationType === "LOSS"
          ? "LOST"
          : input.operationType === "PERSONAL_USE"
            ? "PERSONAL_USE"
            : input.operationType === "ADJUSTMENT_OUT"
              ? "DISPOSED"
              : "IN_STOCK";
    await tx.uniqueStockUnit.update({
      where: { id: unit.id },
      data: {
        storageLocationId: isTransfer ? input.toLocationId : unit.storageLocationId,
        status: isTransfer ? unit.status : status,
      },
    });
    if (!isTransfer) {
      await tx.inventoryLot.update({
        where: { id: unit.inventoryLotId },
        data: { remainingQuantity: 0 },
      });
      const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
        where: {
          itemVariantId_businessUnitId_trackingMode: {
            itemVariantId: variant.id,
            businessUnitId: c.businessUnitId,
            trackingMode: "UNIQUE",
          },
        },
      });
      const quantity = balance.quantity - 1;
      const total = balance.carryingCostTotalJpy - unit.acquisitionCostJpy;
      if (quantity < 0 || total < 0)
        throw new WorkflowError("VALIDATION", "在庫原価残高が不足しています。");
      await tx.inventoryCostBalance.update({
        where: { id: balance.id },
        data: {
          quantity,
          carryingCostTotalJpy: total,
          averageUnitCostJpy: quantity === 0 ? 0 : averageUnitCost(total, quantity),
        },
      });
    }
    await tx.stockMovement.create({
      data: {
        operationId: operation.id,
        itemVariantId: variant.id,
        inventoryLotId: unit.inventoryLotId,
        uniqueStockUnitId: unit.id,
        movementType,
        quantity: isTransfer ? 1 : -1,
        costTotalJpy: isTransfer ? 0n : -unit.acquisitionCostJpy,
        movementAt: operation.occurredAt,
        businessUnitId: c.businessUnitId,
        storageLocationFromId: input.fromLocationId || unit.storageLocationId,
        storageLocationToId: isTransfer ? input.toLocationId : null,
        sourceType: "manual_adjustment",
        sourceId: operation.id,
        idempotencyKey: `${input.idempotencyKey}:0`,
        operatorId: c.operatorId,
        note: `${input.reason}: ${input.note}`.trim(),
      },
    });
  } else if (input.operationType === "ADJUSTMENT_IN") {
    const unitCost = parseYen(input.unitCostJpy);
    const totalCost = unitCost * BigInt(input.quantity);
    const locationId = input.toLocationId || variant.inventoryItem.defaultStorageLocationId;
    if (!locationId) throw new WorkflowError("VALIDATION", "増加先の保管場所を選択してください。");
    const lot = await tx.inventoryLot.create({
      data: {
        itemVariantId: variant.id,
        trackingMode: "QUANTITY",
        receivedDate: date,
        receivedQuantity: input.quantity,
        remainingQuantity: input.quantity,
        landedCostTotalJpy: totalCost,
        unitCostJpy: averageUnitCost(totalCost, input.quantity),
        costStatus: "FINAL",
        storageLocationId: locationId,
      },
    });
    const balance = await tx.inventoryCostBalance.findUnique({
      where: {
        itemVariantId_businessUnitId_trackingMode: {
          itemVariantId: variant.id,
          businessUnitId: c.businessUnitId,
          trackingMode: "QUANTITY",
        },
      },
    });
    const quantity = (balance?.quantity ?? 0) + input.quantity;
    const total = (balance?.carryingCostTotalJpy ?? 0n) + totalCost;
    await tx.inventoryCostBalance.upsert({
      where: {
        itemVariantId_businessUnitId_trackingMode: {
          itemVariantId: variant.id,
          businessUnitId: c.businessUnitId,
          trackingMode: "QUANTITY",
        },
      },
      create: {
        itemVariantId: variant.id,
        businessUnitId: c.businessUnitId,
        trackingMode: "QUANTITY",
        quantity,
        carryingCostTotalJpy: total,
        averageUnitCostJpy: averageUnitCost(total, quantity),
      },
      update: {
        quantity,
        carryingCostTotalJpy: total,
        averageUnitCostJpy: averageUnitCost(total, quantity),
      },
    });
    await tx.stockMovement.create({
      data: {
        operationId: operation.id,
        itemVariantId: variant.id,
        inventoryLotId: lot.id,
        movementType: "ADJUSTMENT_IN",
        quantity: input.quantity,
        costTotalJpy: totalCost,
        movementAt: operation.occurredAt,
        businessUnitId: c.businessUnitId,
        storageLocationToId: locationId,
        sourceType: "manual_adjustment",
        sourceId: operation.id,
        idempotencyKey: `${input.idempotencyKey}:0`,
        operatorId: c.operatorId,
        note: `${input.reason}: ${input.note}`.trim(),
      },
    });
  } else {
    if (!input.fromLocationId)
      throw new WorkflowError("VALIDATION", "移動元の保管場所を選択してください。");
    const movements = await tx.stockMovement.findMany({
      where: {
        itemVariantId: variant.id,
        businessUnitId: c.businessUnitId,
        inventoryLot: { trackingMode: "QUANTITY" },
      },
      select: {
        inventoryLotId: true,
        movementType: true,
        quantity: true,
        storageLocationFromId: true,
        storageLocationToId: true,
      },
    });
    const byLot = locationBalances(movements, input.fromLocationId);
    const lots = await tx.inventoryLot.findMany({
      where: {
        itemVariantId: variant.id,
        trackingMode: "QUANTITY",
        remainingQuantity: { gt: 0 },
      },
      orderBy: [{ receivedDate: "asc" }, { id: "asc" }],
    });
    const receiptDates = await effectiveLotReceiptDates(
      tx,
      lots.map((lot) => lot.id),
    );
    if (lots.some((lot) => !receiptDates.has(lot.id)))
      throw new WorkflowError("HISTORY_INCOMPLETE", "ロットの元の入庫履歴を確認できません。");
    lots.sort(
      (a, b) =>
        receiptDates.get(a.id)!.localeCompare(receiptDates.get(b.id)!) || a.id.localeCompare(b.id),
    );
    let remaining = input.quantity;
    const allocations: Array<{ lot: (typeof lots)[number]; quantity: number }> = [];
    for (const lot of lots) {
      if (receiptDates.get(lot.id)! > input.occurredDate) continue;
      const held = await tx.inventoryReservation.aggregate({
        where: {
          inventoryLotId: lot.id,
          storageLocationId: input.fromLocationId,
          status: "RESERVED",
        },
        _sum: { quantity: true },
      });
      const available =
        Math.min(lot.remainingQuantity, byLot.get(lot.id) ?? 0) -
        (input.operationType === "LOCATION_TRANSFER" ? 0 : (held._sum.quantity ?? 0));
      if (available <= 0) continue;
      const quantity = Math.min(available, remaining);
      allocations.push({ lot, quantity });
      remaining -= quantity;
      if (!remaining) break;
    }
    if (remaining)
      throw new WorkflowError(
        "VALIDATION",
        "移動元の未確保在庫が不足しています。関連する出品・注文の確保を確認してください。",
      );
    const isTransfer = input.operationType === "LOCATION_TRANSFER";
    const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
      where: {
        itemVariantId_businessUnitId_trackingMode: {
          itemVariantId: variant.id,
          businessUnitId: c.businessUnitId,
          trackingMode: "QUANTITY",
        },
      },
    });
    const outgoingCost = isTransfer
      ? 0n
      : plannedOutCost(
          movingAverageOutCost(balance.carryingCostTotalJpy, balance.quantity, input.quantity),
        );
    let allocatedCost = 0n;
    for (const [index, allocation] of allocations.entries()) {
      if (isTransfer) {
        const held = await tx.inventoryReservation.findMany({
          where: {
            inventoryLotId: allocation.lot.id,
            storageLocationId: input.fromLocationId,
            status: "RESERVED",
          },
          orderBy: { id: "asc" },
        });
        const free = (byLot.get(allocation.lot.id) ?? 0) - held.reduce((s, r) => s + r.quantity, 0);
        let moveHeld = Math.max(0, allocation.quantity - free);
        for (const reservation of held) {
          const amount = Math.min(moveHeld, reservation.quantity);
          if (!amount) break;
          if (amount === reservation.quantity)
            await tx.inventoryReservation.update({
              where: { id: reservation.id },
              data: { storageLocationId: input.toLocationId },
            });
          else {
            await tx.inventoryReservation.update({
              where: { id: reservation.id },
              data: { quantity: { decrement: amount } },
            });
            await tx.inventoryReservation.create({
              data: {
                listingId: reservation.listingId,
                salesOrderLineId: reservation.salesOrderLineId,
                itemVariantId: reservation.itemVariantId,
                inventoryLotId: reservation.inventoryLotId,
                storageLocationId: input.toLocationId,
                quantity: amount,
              },
            });
          }
          moveHeld -= amount;
        }
      }
      const last = index === allocations.length - 1;
      const share = isTransfer
        ? 0n
        : -plannedMovementCost(
            `${input.idempotencyKey}:${index}`,
            -(last
              ? outgoingCost - allocatedCost
              : (outgoingCost * BigInt(allocation.quantity)) / BigInt(input.quantity)),
          );
      allocatedCost += share;
      if (!isTransfer)
        await tx.inventoryLot.update({
          where: { id: allocation.lot.id },
          data: { remainingQuantity: { decrement: allocation.quantity } },
        });
      await tx.stockMovement.create({
        data: {
          operationId: operation.id,
          itemVariantId: variant.id,
          inventoryLotId: allocation.lot.id,
          movementType: input.operationType,
          quantity: isTransfer ? allocation.quantity : -allocation.quantity,
          costTotalJpy: isTransfer ? 0n : -share,
          movementAt: operation.occurredAt,
          businessUnitId: c.businessUnitId,
          storageLocationFromId: input.fromLocationId,
          storageLocationToId: isTransfer ? input.toLocationId : null,
          sourceType: "manual_adjustment",
          sourceId: operation.id,
          idempotencyKey: `${input.idempotencyKey}:${index}`,
          operatorId: c.operatorId,
          note: `${input.reason}: ${input.note}`.trim(),
        },
      });
    }
    if (!isTransfer) {
      const quantity = balance.quantity - input.quantity;
      const total = balance.carryingCostTotalJpy - outgoingCost;
      await tx.inventoryCostBalance.update({
        where: { id: balance.id },
        data: {
          quantity,
          carryingCostTotalJpy: total,
          averageUnitCostJpy: quantity === 0 ? 0 : averageUnitCost(total, quantity),
        },
      });
    }
  }

  return {
    id: variant.inventoryItemId,
    detail: {
      operationId: operation.id,
      operationType: input.operationType,
      quantity: input.quantity,
      occurredDate: input.occurredDate,
    },
  };
}
