import type { PrismaClient } from "@/generated/prisma/client";
import type { z } from "zod";
import { stocktakeRecordSchema, inventoryRecordSchema } from "@/lib/validation/workflow";
import { executeInventoryOperation } from "@/lib/inventory/workflow";
import { effectiveOperationTimeline } from "@/lib/inventory/event-dates";
import { bookQuantityAt } from "@/lib/inventory/stocktake-ledger";
import { historicalPreviewAllowed, plannedOperationOrder } from "@/lib/inventory/valuation-session";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";

export async function recordStocktake(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof stocktakeRecordSchema>,
) {
  return runWorkflow(db, c, input, "STOCKTAKE", input.countedDate, async (tx) => {
    if (!input.valuationFingerprint && !historicalPreviewAllowed())
      throw new WorkflowError(
        "VALUATION_REQUIRED",
        "数えた時点の帳簿数と原価への影響を確認してください。",
      );
    const scope = { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId };
    const [revision, variant, location, observations] = await Promise.all([
      tx.inventoryRevision.findUnique({ where: { businessUnitId: c.businessUnitId } }),
      tx.itemVariant.findFirst({
        where: { id: input.variantId, active: true, inventoryItem: { ...scope, status: "ACTIVE" } },
        include: { inventoryItem: true },
      }),
      tx.storageLocation.findFirst({
        where: {
          id: input.locationId,
          workspaceId: c.workspaceId,
          active: true,
          OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
        },
      }),
      tx.stocktakeObservation.findMany({ where: { ...scope, itemVariantId: input.variantId } }),
    ]);
    if ((revision?.revision ?? 0n).toString() !== input.inventoryRevision)
      throw new WorkflowError(
        "CONFLICT",
        "在庫が更新されました。実測値を保持し、帳簿数と影響を再確認してください。",
      );
    if (!variant || !location)
      throw new WorkflowError("CONTEXT_CHANGED", "商品・保管場所の所属と状態を確認してください。");
    const operations = await tx.inventoryOperation.findMany({
      where: {
        ...scope,
        OR: [
          { movements: { some: { itemVariantId: input.variantId, uniqueStockUnitId: null } } },
          { id: { in: observations.map((o) => o.operationId) } },
        ],
      },
      include: {
        movements: { where: { itemVariantId: input.variantId, uniqueStockUnitId: null } },
      },
    });
    const timeline = await effectiveOperationTimeline(tx, operations);
    const events = operations.map((o) => ({
      id: o.id,
      ...timeline.get(o.id)!,
      movements: o.movements,
    }));
    const book = bookQuantityAt(
      events,
      input.variantId,
      input.locationId,
      input.countedDate,
      input.valuationPosition,
      plannedOperationOrder(),
    );
    const difference = input.countedQuantity - book;
    if (
      difference < 0 &&
      (await tx.inventoryReservation.count({
        where: {
          itemVariantId: input.variantId,
          storageLocationId: input.locationId,
          status: "RESERVED",
        },
      }))
    )
      throw new WorkflowError(
        "STOCK_SHORTAGE",
        "出品用の確保在庫がある場所では実測による減少を確定できません。発送済み・返送待ちを数え漏れ扱いにせず、関連出品の現物を確認してください。",
      );
    if (
      variant.inventoryItem.managementType !== "QUANTITY" &&
      !(await tx.inventoryCostBalance.count({
        where: {
          itemVariantId: variant.id,
          businessUnitId: c.businessUnitId,
          trackingMode: "QUANTITY",
        },
      }))
    )
      throw new WorkflowError(
        "VALIDATION",
        "個体のみの商品は数量実測では訂正できません。対象個体を確認してください。",
      );
    if (difference > 0 && input.unitCostJpy === "")
      throw new WorkflowError(
        "VALIDATION",
        "増加する商品の1個原価を確認してください。不明を0円では確定しません。",
        { fields: { unitCostJpy: "増加時は確認した原価を入力してください。" } },
      );
    const operation = await tx.inventoryOperation.create({
      data: {
        ...scope,
        operatorId: c.operatorId,
        operationType: "STOCKTAKE",
        sourceType: "stocktake",
        sourceId: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey,
        occurredAt: new Date(`${input.countedDate}T00:00:00+09:00`),
        valuationOrder: plannedOperationOrder(),
        note: input.reason,
      },
    });
    if (difference !== 0)
      await executeInventoryOperation(
        tx,
        c,
        inventoryRecordSchema.parse({
          context: input.context,
          idempotencyKey: input.idempotencyKey,
          inventoryRevision: input.inventoryRevision,
          operationType: difference > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
          variantId: input.variantId,
          trackingMode: "QUANTITY",
          uniqueStockUnitId: "",
          quantity: Math.abs(difference),
          fromLocationId: difference < 0 ? input.locationId : "",
          toLocationId: difference > 0 ? input.locationId : "",
          occurredDate: input.countedDate,
          unitCostJpy: input.unitCostJpy,
          reason: "数え間違い",
          note: input.reason,
        }),
        operation,
      );
    else
      await tx.inventoryCostBalance.upsert({
        where: {
          itemVariantId_businessUnitId_trackingMode: {
            itemVariantId: input.variantId,
            businessUnitId: c.businessUnitId,
            trackingMode: "QUANTITY",
          },
        },
        create: {
          itemVariantId: input.variantId,
          businessUnitId: c.businessUnitId,
          trackingMode: "QUANTITY",
          quantity: 0,
          carryingCostTotalJpy: 0n,
          averageUnitCostJpy: "0",
        },
        update: {},
      });
    await tx.stocktakeObservation.create({
      data: {
        ...scope,
        reportingEntityId: c.reportingEntityId,
        requestId: input.idempotencyKey,
        operationId: operation.id,
        itemVariantId: input.variantId,
        storageLocationId: input.locationId,
        bookQuantity: book,
        countedQuantity: input.countedQuantity,
        difference,
      },
    });
    return {
      id: variant.inventoryItemId,
      detail: {
        operationId: operation.id,
        countedDate: input.countedDate,
        bookQuantity: book,
        countedQuantity: input.countedQuantity,
        difference,
        locationName: location.name,
      },
    };
  });
}
