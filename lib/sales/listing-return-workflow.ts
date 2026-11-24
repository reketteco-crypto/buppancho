import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { z } from "zod";
import type { listingReturnSchema, listingReturnCloseSchema } from "@/lib/validation/workflow";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { scopedListing } from "@/lib/sales/workflow";
import { runWorkflow } from "@/lib/sales/workflow-runner";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { returnProgress } from "@/lib/sales/listing-return-domain";
import { averageUnitCost, movingAverageOutCost } from "@/lib/inventory/money";
import {
  historicalPreviewAllowed,
  plannedMovementCost,
  plannedOperationOrder,
} from "@/lib/inventory/valuation-session";
import { effectiveOperationDates } from "@/lib/inventory/event-dates";
import { lockInventoryTarget } from "@/lib/inventory/domain-lock";
import {
  assertListingReturnDraft,
  finalizeListingReturnDraft,
} from "@/lib/sales/listing-return-drafts";
type Tx = Prisma.TransactionClient;
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
});
export async function startListingReturnCase(
  tx: Tx,
  c: WorkflowContext,
  listingId: string,
  requestId: string,
  date: string,
) {
  const reservations = await tx.inventoryReservation.findMany({
    where: { listingId, status: "RESERVED" },
    orderBy: { id: "asc" },
  });
  if (!reservations.length)
    throw new WorkflowError("HISTORY_INCOMPLETE", "返送対象の確保在庫がありません。");
  const row = await tx.listingReturnCase.create({
    data: {
      ...scope(c),
      listingId,
      reportingEntityId: c.reportingEntityId,
      requestId,
      startedDate: new Date(date),
    },
  });
  await tx.listingReturnMember.createMany({
    data: reservations.map((r) => ({ caseId: row.id, reservationId: r.id, quantity: r.quantity })),
  });
  return row;
}
export async function loadListingReturn(
  tx: Tx,
  c: WorkflowContext,
  listingId: string,
  caseId?: string,
) {
  const row = await tx.listingReturnCase.findFirst({
    where: { ...scope(c), listingId, ...(caseId ? { id: caseId } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!row)
    throw new WorkflowError(
      "HISTORY_INCOMPLETE",
      "返送案件を確認できません。元の出品記録を確認してください。",
    );
  if (row.reportingEntityId !== c.reportingEntityId)
    throw new WorkflowError("OWNERSHIP_CHANGED", "返送案件の申告主体が異なります。");
  const members = await tx.listingReturnMember.findMany({
    where: { caseId: row.id },
    orderBy: { id: "asc" },
  });
  const handling = await tx.listingReturnHandling.findMany({
    where: { memberId: { in: members.map((m) => m.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return { row, members, handling };
}
export async function recordListingReturn(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof listingReturnSchema>,
) {
  return runWorkflow(db, c, input, "LISTING_RETURN", input.date, async (tx) => {
    const listing = await scopedListing(tx, c, input.listingId, input.revision);
    if (!listing.returnPending || listing.completion || listing.status === "ENDED")
      throw new WorkflowError(
        "CONFLICT",
        "出品の返送状態が変わりました。現在の記録を確認してください。",
      );
    if (!input.valuationFingerprint && !historicalPreviewAllowed())
      throw new WorkflowError(
        "VALUATION_REQUIRED",
        "今回の数量・在庫・原価への影響を確認してください。",
      );
    const { row, members, handling } = await loadListingReturn(tx, c, listing.id);
    await assertListingReturnDraft(tx, c, input, row.id);
    if (input.date < row.startedDate.toISOString().slice(0, 10))
      throw new WorkflowError("VALIDATION", "返送確認日は返送待ちの記録日以降にしてください。");
    for (const entry of input.rows)
      if (!members.some((m) => m.id === entry.memberId))
        throw new WorkflowError("VALIDATION", "返送案件の対象外の構成品です。");
    const reservations = await tx.inventoryReservation.findMany({
      where: { id: { in: members.map((m) => m.reservationId) } },
      orderBy: [{ itemVariantId: "asc" }, { id: "asc" }],
    });
    for (const id of [...new Set(reservations.map((r) => r.itemVariantId))].sort())
      await lockInventoryTarget(tx, id, c.businessUnitId);
    for (const member of members)
      returnProgress(member.quantity, [
        ...handling.filter((h) => h.memberId === member.id),
        ...input.rows.filter((h) => h.memberId === member.id),
      ]);
    const bad = input.rows.some((r) => r.disposition !== "RESTOCK");
    const operation = bad
      ? await tx.inventoryOperation.create({
          data: {
            ...scope(c),
            operatorId: c.operatorId,
            operationType: "SALE_RETURN",
            sourceType: "listing",
            sourceId: listing.id,
            idempotencyKey: input.idempotencyKey,
            occurredAt: new Date(`${input.date}T00:00:00+09:00`),
            valuationOrder: plannedOperationOrder(),
            note: input.reason,
          },
        })
      : null;
    for (const entry of input.rows) {
      const member = members.find((m) => m.id === entry.memberId)!;
      let cost = 0n;
      if (entry.disposition !== "RESTOCK") {
        const r = await tx.inventoryReservation.findUniqueOrThrow({
          where: { id: member.reservationId },
        });
        if (r.status !== "RESERVED" || r.quantity < entry.quantity)
          throw new WorkflowError("CONFLICT", "元の確保数量が変わりました。再確認してください。");
        const unit = r.uniqueStockUnitId
          ? await tx.uniqueStockUnit.findUniqueOrThrow({ where: { id: r.uniqueStockUnitId } })
          : null;
        if (unit && entry.quantity !== 1)
          throw new WorkflowError("VALIDATION", "個体は1点ずつ確認してください。");
        const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
          where: {
            itemVariantId_businessUnitId_trackingMode: {
              itemVariantId: r.itemVariantId,
              businessUnitId: c.businessUnitId,
              trackingMode: unit ? "UNIQUE" : "QUANTITY",
            },
          },
        });
        const key = `${input.idempotencyKey}:${member.id}:${entry.disposition}:out`;
        cost =
          unit?.acquisitionCostJpy ??
          -plannedMovementCost(
            key,
            -movingAverageOutCost(balance.carryingCostTotalJpy, balance.quantity, entry.quantity),
          );
        const quantity = balance.quantity - entry.quantity,
          total = balance.carryingCostTotalJpy - cost;
        if (quantity < 0 || total < 0)
          throw new WorkflowError("STOCK_SHORTAGE", "在庫または原価残高が不足しています。");
        await tx.inventoryCostBalance.update({
          where: { id: balance.id },
          data: {
            quantity,
            carryingCostTotalJpy: total,
            averageUnitCostJpy: quantity ? averageUnitCost(total, quantity) : "0",
          },
        });
        const lotId = unit?.inventoryLotId ?? r.inventoryLotId!;
        await tx.inventoryLot.update({
          where: { id: lotId },
          data: { remainingQuantity: { decrement: entry.quantity } },
        });
        await tx.inventoryReservation.update({
          where: { id: r.id },
          data:
            entry.quantity === r.quantity
              ? { status: "CONSUMED" }
              : { quantity: { decrement: entry.quantity } },
        });
        if (unit)
          await tx.uniqueStockUnit.update({
            where: { id: unit.id },
            data: {
              status:
                entry.disposition === "DEFECTIVE"
                  ? "RETURNED"
                  : entry.disposition === "LOST"
                    ? "LOST"
                    : "DISPOSED",
            },
          });
        const common = {
          operationId: operation!.id,
          itemVariantId: r.itemVariantId,
          inventoryLotId: lotId,
          uniqueStockUnitId: r.uniqueStockUnitId,
          movementAt: operation!.occurredAt,
          businessUnitId: c.businessUnitId,
          sourceType: "listing",
          sourceId: listing.id,
          operatorId: c.operatorId,
          note: input.reason,
        };
        await tx.stockMovement.create({
          data: {
            ...common,
            movementType: entry.disposition === "LOST" ? "LOSS" : "ADJUSTMENT_OUT",
            quantity: -entry.quantity,
            costTotalJpy: -cost,
            storageLocationFromId: r.storageLocationId,
            idempotencyKey: key,
          },
        });
        if (entry.disposition !== "LOST")
          await tx.stockMovement.create({
            data: {
              ...common,
              movementType:
                entry.disposition === "DEFECTIVE" ? "RETURN_DEFECTIVE" : "RETURN_DISPOSAL",
              quantity: entry.quantity,
              costTotalJpy: cost,
              storageLocationToId: r.storageLocationId,
              idempotencyKey: key.replace(/:out$/, ":disposition"),
            },
          });
      }
      await tx.listingReturnHandling.create({
        data: {
          memberId: member.id,
          requestId: input.idempotencyKey,
          operationId: entry.disposition === "RESTOCK" ? null : operation!.id,
          quantity: entry.quantity,
          disposition: entry.disposition,
          handledDate: new Date(input.date),
          costTotalJpy: cost,
        },
      });
    }
    await tx.listing.update({ where: { id: listing.id }, data: { revision: { increment: 1 } } });
    await finalizeListingReturnDraft(tx, c, input, row.id, "LISTING_RETURN");
    return {
      id: listing.id,
      detail: {
        reason: input.reason,
        rows: input.rows,
        caseId: row.id,
        retained: "良品・未返送分の確保を維持",
      },
    };
  });
}
export async function closeListingReturn(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof listingReturnCloseSchema>,
) {
  if (input.goodsInHand !== true)
    throw new WorkflowError("VALIDATION", "現物と処理結果の確認が必要です。");
  return runWorkflow(db, c, input, "LISTING_RETURN_CLOSE", input.date, async (tx) => {
    const listing = await scopedListing(tx, c, input.listingId, input.revision);
    if (!listing.returnPending || listing.completion || listing.status === "ENDED")
      throw new WorkflowError("CONFLICT", "返送案件の状態が変わりました。");
    const { row, members, handling } = await loadListingReturn(tx, c, listing.id);
    await assertListingReturnDraft(tx, c, input, row.id);
    const progress = members.map((m) =>
      returnProgress(
        m.quantity,
        handling.filter((h) => h.memberId === m.id),
      ),
    );
    if (!progress.length || progress.some((p) => p.pending))
      throw new WorkflowError("VALIDATION", "未処理の構成品があります。未返送分を解放できません。");
    if (input.action === "RESUME" && progress.some((p) => !p.allGood))
      throw new WorkflowError(
        "VALIDATION",
        "元の構成品が全量良品で揃った場合だけ同じ出品を再開できます。",
      );
    const operations = await tx.inventoryOperation.findMany({
      where: {
        ...scope(c),
        id: { in: handling.flatMap((h) => (h.operationId ? [h.operationId] : [])) },
      },
    });
    const dates = await effectiveOperationDates(tx, operations);
    if (
      input.date < row.startedDate.toISOString().slice(0, 10) ||
      handling.some(
        (h) =>
          (h.operationId ? dates.get(h.operationId)! : h.handledDate.toISOString().slice(0, 10)) >
          input.date,
      )
    )
      throw new WorkflowError("VALIDATION", "全数の確認日以降の日付を指定してください。");
    if (input.action === "END") {
      const reservations = await tx.inventoryReservation.findMany({
        where: { listingId: listing.id, status: "RESERVED" },
      });
      await tx.inventoryReservation.updateMany({
        where: { listingId: listing.id, status: "RESERVED" },
        data: { status: "RELEASED" },
      });
      for (const r of reservations)
        if (r.uniqueStockUnitId)
          await tx.uniqueStockUnit.update({
            where: { id: r.uniqueStockUnitId },
            data: { status: "IN_STOCK" },
          });
    }
    await tx.listing.update({
      where: { id: listing.id },
      data: {
        returnPending: false,
        status: input.action === "END" ? "ENDED" : "ACTIVE",
        revision: { increment: 1 },
        ...(input.action === "END" ? { reservedQuantity: 0 } : {}),
      },
    });
    await finalizeListingReturnDraft(tx, c, input, row.id, "LISTING_RETURN_CLOSE");
    return {
      id: listing.id,
      detail: { caseId: row.id, action: input.action, reason: input.reason, goodsInHand: true },
    };
  });
}
