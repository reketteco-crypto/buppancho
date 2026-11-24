import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { z } from "zod";
import { nextWorkspaceCode } from "@/lib/inventory/codes";
import { reservationConflicts } from "@/lib/sales/reconciliation";
import { averageUnitCost, movingAverageOutCost } from "@/lib/inventory/money";
import { lockInventoryDomain } from "@/lib/inventory/domain-lock";
import { effectiveLotReceiptDates } from "@/lib/inventory/event-dates";
import {
  buildCompletionValuation,
  applyCompletionValuation,
  type CompletionValuation,
} from "@/lib/inventory/completion-valuation";
import { fingerprint } from "@/lib/sales/request-store";
import { checkWorkflowContext, type WorkflowContext } from "@/lib/sales/workflow-context";
import { runWorkflow as run } from "@/lib/sales/workflow-runner";
export { checkWorkflowContext, type WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { startListingReturnCase } from "@/lib/sales/listing-return-workflow";
import { assertInputOrigin } from "@/lib/sales/input-origin";
import {
  mercariReference,
  type listingRecordSchema,
  type completionRecordSchema,
  type listingEventSchema,
  type amountAmendSchema,
  type priceRecordSchema,
  type refundRecordSchema,
} from "@/lib/validation/workflow";

type Tx = Prisma.TransactionClient;
type Component = {
  itemVariantId: string | null;
  uniqueStockUnitId: string | null;
  requiredQuantity: number;
};
export const jsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)));
const scope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
});
const instant = (date: string) => new Date(`${date}T00:00:00+09:00`);
const dateOnly = (date: string) => new Date(`${date}T00:00:00Z`);

async function lock(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
}

export async function scopedListing(tx: Tx, c: WorkflowContext, id: string, revision: number) {
  await lock(tx, `listing:${id}`);
  const listing = await tx.listing.findFirst({
    where: { id, salesSku: scope(c) },
    include: { salesSku: { include: { components: true } }, completion: true },
  });
  if (!listing) throw new Error("この部門の出品が見つかりません。");
  if (listing.revision !== revision)
    throw new WorkflowError(
      "CONFLICT",
      "別端末で記録が更新されました。入力を保持して詳細を再読み込みし、変更内容を確認してください。",
    );
  const listingYear = Number(
    listing.listedAt.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 4),
  );
  if (listing.originReportingEntityId && listing.originReportingEntityId !== c.reportingEntityId)
    throw new WorkflowError(
      "OWNERSHIP_CHANGED",
      "出品時と申告主体が異なります。在庫移管の確認が必要です。",
    );
  if (listingYear !== c.year && !listing.originReportingEntityId)
    throw new WorkflowError(
      "OWNERSHIP_CHANGED",
      "出品時の帰属を確認できません。元の設定・出品記録を確認してください。",
    );
  return listing;
}

async function lockComponents(tx: Tx, c: WorkflowContext, components: Component[]) {
  const ids: string[] = [];
  for (const part of components) {
    const variant = part.itemVariantId
      ? await tx.itemVariant.findFirst({
          where: { id: part.itemVariantId, active: true, inventoryItem: scope(c) },
        })
      : await tx.uniqueStockUnit.findFirst({
          where: {
            id: part.uniqueStockUnitId!,
            workspaceId: c.workspaceId,
            itemVariant: { inventoryItem: scope(c) },
          },
        });
    if (!variant)
      throw new Error("構成商品が別部門にあるか、利用できません。商品を選び直してください。");
    ids.push(part.itemVariantId ?? (variant as { itemVariantId: string }).itemVariantId);
  }
  for (const id of [...new Set(ids)].sort()) await lock(tx, `${id}:${c.businessUnitId}`);
}

// Shared with inventory mutations: lot.location is an initial location, not its current balance.
export async function lotLocations(tx: Tx, lotId: string) {
  const movements = await tx.stockMovement.findMany({
    where: {
      inventoryLotId: lotId,
      uniqueStockUnitId: null,
      movementType: { notIn: ["RETURN_DEFECTIVE", "RETURN_DISPOSAL"] },
    },
  });
  const balances = new Map<string, number>();
  for (const m of movements) {
    if (m.storageLocationFromId)
      balances.set(
        m.storageLocationFromId,
        (balances.get(m.storageLocationFromId) ?? 0) - Math.abs(m.quantity),
      );
    if (m.storageLocationToId)
      balances.set(
        m.storageLocationToId,
        (balances.get(m.storageLocationToId) ?? 0) + Math.abs(m.quantity),
      );
  }
  return [...balances.entries()].sort(([a], [b]) => a.localeCompare(b));
}

async function reserve(tx: Tx, c: WorkflowContext, listingId: string, components: Component[]) {
  await lockComponents(tx, c, components);
  for (const part of components) {
    if (part.uniqueStockUnitId) {
      const unit = await tx.uniqueStockUnit.findUniqueOrThrow({
        where: { id: part.uniqueStockUnitId },
      });
      if (
        unit.status !== "IN_STOCK" ||
        (await tx.inventoryReservation.count({
          where: { uniqueStockUnitId: unit.id, status: "RESERVED" },
        }))
      )
        throw new Error("別操作で個体が確保済みです。在庫詳細の関連出品を確認してください。");
      await tx.inventoryReservation.create({
        data: {
          listingId,
          itemVariantId: unit.itemVariantId,
          uniqueStockUnitId: unit.id,
          storageLocationId: unit.storageLocationId,
          quantity: 1,
        },
      });
      await tx.uniqueStockUnit.update({ where: { id: unit.id }, data: { status: "RESERVED" } });
    } else {
      const lots = await tx.inventoryLot.findMany({
        where: {
          itemVariantId: part.itemVariantId!,
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
        throw new WorkflowError("HISTORY_INCOMPLETE", "確保対象ロットの入庫履歴を確認できません。");
      lots.sort(
        (a, b) =>
          receiptDates.get(a.id)!.localeCompare(receiptDates.get(b.id)!) ||
          a.id.localeCompare(b.id),
      );
      let needed = part.requiredQuantity;
      for (const lot of lots) {
        const held = await tx.inventoryReservation.groupBy({
          by: ["storageLocationId"],
          where: { inventoryLotId: lot.id, status: "RESERVED" },
          _sum: { quantity: true },
        });
        let freeLot = lot.remainingQuantity - held.reduce((s, r) => s + (r._sum.quantity ?? 0), 0);
        if (freeLot < 0)
          throw new Error(
            "在庫確保の不整合があります。販売画面の関連出品と在庫履歴を確認してください。",
          );
        for (const [locationId, balance] of await lotLocations(tx, lot.id)) {
          const available =
            balance - (held.find((h) => h.storageLocationId === locationId)?._sum.quantity ?? 0);
          if (available < 0)
            throw new Error(
              "保管場所と確保先が一致しません。関連する出品・在庫移動を確認してください。",
            );
          const quantity = Math.min(needed, available, freeLot);
          if (quantity > 0) {
            await tx.inventoryReservation.create({
              data: {
                listingId,
                itemVariantId: part.itemVariantId!,
                inventoryLotId: lot.id,
                storageLocationId: locationId,
                quantity,
              },
            });
            needed -= quantity;
            freeLot -= quantity;
          }
          if (!needed) break;
        }
        if (!needed) break;
      }
      if (needed)
        throw new Error(
          `在庫不足：あと${needed}個必要です。関連出品とメルカリ側の出品状況を確認してください。`,
        );
    }
  }
}

export async function recordListing(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof listingRecordSchema>,
) {
  const ref = mercariReference(input.externalReference);
  return run(db, c, input, "LIST", input.listedDate, async (tx) => {
    if ((await reservationConflicts(tx, c.workspaceId, c.businessUnitId)).length)
      throw new Error(
        "在庫確保の不整合があるため、新しい確保を停止しています。販売画面の案内から関連出品・在庫履歴を確認してください。",
      );
    if (input.draftId) await lock(tx, `draft:${input.draftId}`);
    const sourceDraft = input.draftId
      ? await tx.workflowDraft.findUnique({ where: { id: input.draftId } })
      : null;
    assertInputOrigin(sourceDraft?.baseSnapshot ?? input.baseSnapshot, c);
    const channel = await tx.salesChannel.findFirst({
      where: { workspaceId: c.workspaceId, type: "MERCARI", active: true },
    });
    if (!channel || channel.defaultFeeRate === null)
      throw new Error("販路設定でメルカリの手数料率を確認・保存してから戻ってください。");
    if (input.channelRevision !== undefined && input.channelRevision !== channel.revision)
      throw new WorkflowError(
        "CONFLICT",
        "見込み確認後に販路設定が変わりました。最新の手数料率で見込みを確認し直してください。",
      );
    await lock(tx, `external-listing:${channel.id}:${ref.id}`);
    const duplicate = await tx.listing.findUnique({
      where: {
        salesChannelId_externalListingId: { salesChannelId: channel.id, externalListingId: ref.id },
      },
    });
    if (duplicate)
      throw new WorkflowError(
        "DUPLICATE",
        "二重登録：この商品IDの出品は記録済みです。「すべて」の出品一覧から商品IDで検索してください。",
      );
    await lockComponents(tx, c, input.components);
    // Reuse only a structurally identical SKU. The listing's snapshot is authoritative thereafter.
    const candidates = await tx.salesSku.findMany({
      where: { ...scope(c), active: true },
      include: { components: true },
    });
    const signature = (parts: Component[]) =>
      parts
        .map((p) => `${p.itemVariantId ?? p.uniqueStockUnitId}:${p.requiredQuantity}`)
        .sort()
        .join("|");
    const bundle =
      input.components.length > 1 || input.components.some((p) => p.requiredQuantity > 1);
    let sku = candidates.find(
      (v) =>
        signature(v.components) === signature(input.components) &&
        (!bundle || v.name === input.name),
    );
    if (!sku)
      sku = await tx.salesSku.create({
        data: {
          ...scope(c),
          name: input.name,
          skuType:
            input.components.length === 1 && input.components[0]!.requiredQuantity === 1
              ? "SINGLE"
              : "BUNDLE",
          skuCode: await nextWorkspaceCode(tx, c.workspaceId, "SALES_SKU"),
          requestKey: randomUUID(),
          components: { create: input.components },
        },
        include: { components: true },
      });
    const listing = await tx.listing.create({
      data: {
        originReportingEntityId: c.reportingEntityId,
        originYear: c.year,
        originAssignmentId: (
          await tx.businessUnitAssignment.findFirstOrThrow({
            where: {
              businessUnitId: c.businessUnitId,
              fiscalYearProfile: { year: c.year, reportingEntityId: c.reportingEntityId },
              effectiveFrom: { lte: dateOnly(input.listedDate) },
              effectiveTo: { gte: dateOnly(input.listedDate) },
            },
          })
        ).id,
        workflowVersion: 2,
        salesSkuId: sku.id,
        salesChannelId: channel.id,
        externalListingId: ref.id,
        url: ref.url,
        listedAt: instant(input.listedDate),
        currentPriceJpy: input.price,
        listedQuantity: 1,
        reservedQuantity: 1,
        expectedShippingJpy: input.expectedShipping,
        displayName: input.name,
        expectedFeeSource: input.expectedFeeSource ?? "RATE",
        expectedFeeJpy: input.expectedFeeSource === "AMOUNT" ? (input.expectedFee ?? null) : null,
        expectedPackingJpy: input.expectedPacking ?? null,
        expectedOtherJpy: input.expectedOther ?? null,
        feeRate: channel.defaultFeeRate,
        status: "ACTIVE",
        requestKey: input.idempotencyKey,
        componentsSnapshot: jsonValue(input.components),
        priceHistory: {
          create: {
            priceJpy: input.price,
            effectiveAt: instant(input.listedDate),
            operatorId: c.operatorId,
            idempotencyKey: input.idempotencyKey,
            reason: "出品を記録",
          },
        },
      },
    });
    await reserve(tx, c, listing.id, input.components);
    if (input.draftId) {
      const draft = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
      if (
        draft?.archivedAt ||
        (input.draftRevision !== undefined && (draft?.revision ?? 0) !== input.draftRevision)
      )
        throw new WorkflowError(
          "CONFLICT",
          "途中保存が別操作で更新されました。最新の内容と手元の入力を確認してください。",
        );
      if (
        draft &&
        (draft.workspaceId !== c.workspaceId ||
          draft.businessUnitId !== c.businessUnitId ||
          draft.operatorId !== c.operatorId ||
          draft.year !== c.year ||
          draft.kind !== "LISTING")
      )
        throw new Error("途中保存の入力先が一致しません。");
      await tx.workflowDraft.upsert({
        where: { id: input.draftId },
        create: {
          id: input.draftId,
          ...scope(c),
          operatorId: c.operatorId,
          year: c.year,
          kind: "LISTING",
          baseSnapshot: input.baseSnapshot ? jsonValue(input.baseSnapshot) : undefined,
          payload: jsonValue(input),
          archivedAt: new Date(),
        },
        update: { archivedAt: new Date() },
      });
    }
    return { id: listing.id, detail: { components: input.components, reserved: true } };
  });
}

async function consume(
  tx: Tx,
  c: WorkflowContext,
  listingId: string,
  lineId: string,
  orderId: string,
  key: string,
  date: string,
  components: Component[],
  valuation: CompletionValuation,
) {
  await lockComponents(tx, c, components);
  const rows = await tx.inventoryReservation.findMany({
    where: { listingId, status: "RESERVED" },
    orderBy: [{ itemVariantId: "asc" }, { id: "asc" }],
  });
  if (!rows.length) throw new Error("確保在庫がありません。関連出品と在庫履歴を確認してください。");
  const targetKey = (p: { itemVariantId: string | null; uniqueStockUnitId: string | null }) =>
    p.uniqueStockUnitId ? `unit:${p.uniqueStockUnitId}` : `variant:${p.itemVariantId}`;
  const expected = new Map(components.map((p) => [targetKey(p), p.requiredQuantity]));
  const held = new Map<string, number>();
  for (const row of rows) held.set(targetKey(row), (held.get(targetKey(row)) ?? 0) + row.quantity);
  if (expected.size !== held.size || [...expected].some(([id, qty]) => held.get(id) !== qty))
    throw new Error(
      "出品時の構成と確保数が一致しません。完了は保存されていません。関連在庫の確認が必要です。",
    );
  const operation = await tx.inventoryOperation.create({
    data: {
      ...scope(c),
      operatorId: c.operatorId,
      operationType: "SALE_COMPLETION",
      sourceType: "sales_order",
      sourceId: orderId,
      idempotencyKey: key,
      occurredAt: instant(date),
      valuationOrder: valuation.order,
    },
  });
  let totalCost = 0n;
  let final = true;
  for (const variantId of [...new Set(rows.map((r) => r.itemVariantId))].sort()) {
    await lock(tx, `${variantId}:${c.businessUnitId}`);
    for (const mode of ["QUANTITY", "UNIQUE"] as const) {
      const group = rows.filter(
        (r) =>
          r.itemVariantId === variantId && Boolean(r.uniqueStockUnitId) === (mode === "UNIQUE"),
      );
      if (!group.length) continue;
      const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
        where: {
          itemVariantId_businessUnitId_trackingMode: {
            itemVariantId: variantId,
            businessUnitId: c.businessUnitId,
            trackingMode: mode,
          },
        },
      });
      const qty = group.reduce((s, r) => s + r.quantity, 0);
      if (
        mode === "QUANTITY" &&
        (await tx.inventoryLot.count({
          where: {
            itemVariantId: variantId,
            trackingMode: "QUANTITY",
            remainingQuantity: { gt: 0 },
            costStatus: "PROVISIONAL",
          },
        }))
      )
        final = false;
      let allocated = 0n;
      for (const row of group) {
        const unit = row.uniqueStockUnitId
          ? await tx.uniqueStockUnit.findUniqueOrThrow({ where: { id: row.uniqueStockUnitId } })
          : null;
        if (
          unit &&
          (unit.status !== "RESERVED" || unit.storageLocationId !== row.storageLocationId)
        )
          throw new Error("個体の確保状態が変わりました。再読み込みしてください。");
        const lotId = unit?.inventoryLotId ?? row.inventoryLotId!;
        const lot = await tx.inventoryLot.findUniqueOrThrow({ where: { id: lotId } });
        if (lot.remainingQuantity < row.quantity)
          throw new Error("確保数と管理在庫が一致しません。関連出品と在庫履歴を確認してください。");
        if (
          !unit &&
          ((await lotLocations(tx, lot.id)).find(([id]) => id === row.storageLocationId)?.[1] ??
            0) < row.quantity
        )
          throw new Error("確保先の保管場所に在庫がありません。");
        // Floor non-final allocations; the final row receives the remainder, never a negative cost.
        const cost = valuation.pendingCosts.get(row.id);
        if (cost === undefined)
          throw new WorkflowError(
            "CONFLICT",
            "確保内容が変更されました。原価を再確認してください。",
          );
        allocated += cost;
        const costStatus = lot.costStatus;
        final &&= costStatus === "FINAL";
        await tx.inventoryLot.update({
          where: { id: lot.id },
          data: { remainingQuantity: { decrement: row.quantity } },
        });
        if (unit)
          await tx.uniqueStockUnit.update({ where: { id: unit.id }, data: { status: "SOLD" } });
        await tx.orderComponentConsumption.create({
          data: {
            salesOrderLineId: lineId,
            itemVariantId: variantId,
            inventoryLotId: unit ? null : lot.id,
            uniqueStockUnitId: unit?.id,
            storageLocationId: row.storageLocationId,
            quantity: row.quantity,
            unitCostJpy: averageUnitCost(cost, row.quantity),
            costTotalJpy: cost,
            costStatus,
          },
        });
        await tx.stockMovement.create({
          data: {
            operationId: operation.id,
            itemVariantId: variantId,
            inventoryLotId: lot.id,
            uniqueStockUnitId: unit?.id,
            movementType: "SALE_OUT",
            quantity: -row.quantity,
            costTotalJpy: -cost,
            movementAt: instant(date),
            businessUnitId: c.businessUnitId,
            storageLocationFromId: row.storageLocationId,
            sourceType: "sales_order",
            sourceId: orderId,
            idempotencyKey: `${key}:${row.id}`,
            operatorId: c.operatorId,
          },
        });
      }
      const nextQty = balance.quantity - qty,
        nextCost =
          mode === "QUANTITY"
            ? valuation.balances.get(variantId)!.after
            : balance.carryingCostTotalJpy - allocated;
      if (nextQty < 0 || nextCost < 0n)
        throw new Error("在庫残高に不整合があります。完了は保存されていません。");
      await tx.inventoryCostBalance.update({
        where: { id: balance.id },
        data: {
          quantity: nextQty,
          carryingCostTotalJpy: nextCost,
          averageUnitCostJpy: nextQty ? averageUnitCost(nextCost, nextQty) : "0",
        },
      });
      totalCost += allocated;
    }
  }
  await tx.inventoryReservation.updateMany({
    where: { listingId, status: "RESERVED" },
    data: { status: "CONSUMED" },
  });
  await tx.salesOrderLine.update({ where: { id: lineId }, data: { managementCogsJpy: totalCost } });
  return final;
}

function completionConfirmation(valuation: string, input: z.output<typeof completionRecordSchema>) {
  return fingerprint({
    valuation,
    context: input.context,
    listingId: input.listingId,
    revision: input.revision,
    completedDate: input.completedDate,
    valuationPosition: input.valuationPosition ?? "LAST",
    actualPrice: input.actualPrice,
    fee: input.fee,
    shipping: input.shipping,
    packing: input.packing,
    other: input.other,
    purchasedDate: input.purchasedDate,
    shippedDate: input.shippedDate,
    shippingMethod: input.shippingMethod,
    trackingNumber: input.trackingNumber,
    externalOrderId: input.externalOrderId,
    memo: input.memo,
  });
}
export async function recordCompletion(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof completionRecordSchema>,
) {
  return run(db, c, input, "COMPLETE", input.completedDate, async (tx) => {
    if (input.draftId) await lock(tx, `draft:${input.draftId}`);
    const listing = await scopedListing(tx, c, input.listingId, input.revision);
    if (instant(input.completedDate) < listing.listedAt)
      throw new Error("完了日は出品日以後を指定してください。");
    if (listing.workflowVersion !== 2)
      throw new Error("旧方式の出品は更新できません。販売一覧から新方式の記録を確認してください。");
    if (
      listing.completion ||
      !["ACTIVE", "PAUSED"].includes(listing.status) ||
      listing.returnPending
    )
      throw new Error(
        "状態遷移不可：この出品は完了記録済み、終了、または返送確認待ちです。詳細を確認してください。",
      );
    const valuation = await buildCompletionValuation(
      tx,
      c,
      listing.id,
      input.completedDate,
      input.valuationPosition,
    );
    if (valuation.requiresOrder)
      throw new WorkflowError("VALUATION_REQUIRED", "同日の取引順序を確認してください。");
    if (
      (input.valuationFingerprint &&
        input.valuationFingerprint !== completionConfirmation(valuation.fingerprint, input)) ||
      (!input.valuationFingerprint && valuation.changes.length)
    )
      throw new WorkflowError(
        "VALUATION_REQUIRED",
        "原価への影響が変わりました。内容を再確認してください。",
      );
    const order = await tx.salesOrder.create({
      data: {
        ...scope(c),
        reportingEntityId: c.reportingEntityId,
        salesChannelId: listing.salesChannelId,
        completionListingId: listing.id,
        externalOrderId: input.externalOrderId || null,
        orderedAt: input.purchasedDate ? instant(input.purchasedDate) : null,
        completedAt: instant(input.completedDate),
        accountingRecognitionDate: dateOnly(input.completedDate),
        status: "COMPLETED",
        grossSalesJpy: input.actualPrice,
        feeJpy: input.fee,
        shippingJpy: input.shipping,
        packingJpy: input.packing,
        otherCostJpy: input.other,
        memo: input.memo || null,
        requestKey: input.idempotencyKey,
        lines: {
          create: {
            listingId: listing.id,
            salesSkuId: listing.salesSkuId,
            displayName: listing.displayName ?? listing.salesSku.name,
            quantity: 1,
            unitPriceJpy: input.actualPrice,
          },
        },
        ...(input.shippedDate || input.shippingMethod || input.trackingNumber
          ? {
              shipment: {
                create: {
                  shippedAt: input.shippedDate ? instant(input.shippedDate) : null,
                  shippingMethod: input.shippingMethod || null,
                  trackingNumber: input.trackingNumber || null,
                  actualShippingJpy: input.shipping,
                },
              },
            }
          : {}),
      },
      include: { lines: true },
    });
    const final = await consume(
      tx,
      c,
      listing.id,
      order.lines[0]!.id,
      order.id,
      input.idempotencyKey,
      input.completedDate,
      listing.componentsSnapshot as Component[],
      valuation,
    );
    await applyCompletionValuation(tx, c, input.idempotencyKey, order.id, valuation);
    await tx.salesOrder.update({
      where: { id: order.id },
      data: { costStatus: final && valuation.final ? "FINAL" : "PROVISIONAL" },
    });
    await tx.salesOrderEvent.create({
      data: {
        salesOrderId: order.id,
        fromStatus: null,
        toStatus: "COMPLETED",
        occurredAt: instant(input.completedDate),
        operatorId: c.operatorId,
        reason: "完了実績を直接記録（購入・発送の状態は推測しない）",
        idempotencyKey: input.idempotencyKey,
      },
    });
    await tx.listing.update({
      where: { id: listing.id },
      data: {
        status: "SOLD_OUT",
        listedQuantity: 0,
        reservedQuantity: 0,
        revision: { increment: 1 },
      },
    });
    if (input.draftId) {
      const draft = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
      if (
        draft?.archivedAt ||
        (input.draftRevision !== undefined && (draft?.revision ?? 0) !== input.draftRevision)
      )
        throw new WorkflowError(
          "CONFLICT",
          "途中保存が別操作で更新されました。最新の内容と手元の入力を確認してください。",
        );
      if (
        draft &&
        (draft.workspaceId !== c.workspaceId ||
          draft.businessUnitId !== c.businessUnitId ||
          draft.operatorId !== c.operatorId ||
          draft.year !== c.year ||
          draft.kind !== "COMPLETION")
      )
        throw new Error("途中保存の入力先が一致しません。");
      await tx.workflowDraft.upsert({
        where: { id: input.draftId },
        create: {
          id: input.draftId,
          ...scope(c),
          operatorId: c.operatorId,
          year: c.year,
          kind: "COMPLETION",
          payload: jsonValue(input),
          archivedAt: new Date(),
        },
        update: { archivedAt: new Date() },
      });
    }
    return {
      id: order.id,
      detail: {
        listingId: listing.id,
        unknownCosts: [input.fee, input.shipping, input.packing, input.other].some(
          (v) => v === null,
        ),
        finalCost: final,
      },
    };
  });
}

export async function previewCompletion(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof completionRecordSchema>,
) {
  return db.$transaction(
    async (tx) => {
      await lockInventoryDomain(tx, c.businessUnitId);
      await checkWorkflowContext(tx, c, input.completedDate);
      const listing = await scopedListing(tx, c, input.listingId, input.revision);
      if (
        listing.completion ||
        listing.returnPending ||
        !["ACTIVE", "PAUSED"].includes(listing.status)
      )
        throw new WorkflowError(
          "CONFLICT",
          "出品状態が変わりました。最新の記録を確認してください。",
        );
      if (instant(input.completedDate) < listing.listedAt)
        throw new WorkflowError("VALIDATION", "完了日は出品日以後を指定してください。");
      const valuation = await buildCompletionValuation(
        tx,
        c,
        listing.id,
        input.completedDate,
        input.valuationPosition,
      );
      return {
        ...valuation,
        fingerprint: valuation.requiresOrder
          ? ""
          : completionConfirmation(valuation.fingerprint, input),
      };
    },
    { timeout: 20000 },
  );
}

export async function recordListingEvent(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof listingEventSchema>,
) {
  if (input.event === "RETURN_RECEIVED")
    throw new WorkflowError("VALIDATION", "返送確認は部分返送の専用画面から記録してください。");
  if (input.event === "MIGRATE")
    throw new WorkflowError(
      "VALIDATION",
      "旧方式の移行操作は終了しました。新しい出品を記録してください。",
    );
  return run(db, c, input, "EVENT", input.date, async (tx) => {
    const listing = await scopedListing(tx, c, input.listingId, input.revision);
    if (listing.completion) throw new Error("完了後は元取引から返品・返金を記録してください。");
    const components =
      listing.workflowVersion === 2
        ? (listing.componentsSnapshot as Component[])
        : listing.salesSku.components;
    await lockComponents(tx, c, components);
    if (input.event === "RETURN_PENDING") {
      if (input.date < listing.listedAt.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }))
        throw new WorkflowError("VALIDATION", "返送待ちの日付は出品日以降にしてください。");
      if (listing.returnPending)
        throw new WorkflowError(
          "CONFLICT",
          "この出品は返送確認待ちです。現在の返送案件を確認してください。",
        );
      await startListingReturnCase(tx, c, listing.id, input.idempotencyKey, input.date);
    }
    if (input.event === "MIGRATE") {
      if (
        listing.workflowVersion !== 1 ||
        listing.listedQuantity < 1 ||
        input.legacyQuantity !== listing.listedQuantity ||
        listing.reservedQuantity !== 0 ||
        (await tx.salesOrderLine.count({
          where: {
            listingId: listing.id,
            salesOrder: { status: { notIn: ["CANCELLED", "RETURNED"] } },
          },
        }))
      )
        throw new Error(
          "自動移行できません。複数数量・ID不足・既存注文の対応を確認してください。元の履歴は保持されています。",
        );
      if (!input.goodsInHand)
        throw new Error("この1出品に割り当てる商品が手元にあることを確認してください。");
      const reference = mercariReference(
        input.externalReference || listing.externalListingId || "",
      );
      if (listing.externalListingId && listing.externalListingId !== reference.id)
        throw new Error(
          "既存の商品IDを別の出品IDに変更して移行することはできません。対応する実際の出品を確認してください。",
        );
      await reserve(tx, c, listing.id, components);
      await tx.listing.update({
        where: { id: listing.id },
        data: {
          workflowVersion: 2,
          listedQuantity: 1,
          externalListingId: reference.id,
          url: reference.url,
          componentsSnapshot: jsonValue(components),
          status: "ACTIVE",
          reservedQuantity: 1,
          revision: { increment: 1 },
        },
      });
    } else {
      if (listing.workflowVersion !== 2)
        throw new Error(
          "旧方式の記録は更新できません。販売一覧から新方式の記録を確認してください。",
        );
      if (listing.status === "ENDED")
        throw new Error("終了済みです。新しい商品IDで再出品を記録してください。");
      if (["END", "RESUME"].includes(input.event) && !input.goodsInHand)
        throw new Error("現物確認が必要です。返送待ちなら「返送確認待ち」を選択してください。");
      if (listing.returnPending && !["RETURN_RECEIVED"].includes(input.event))
        throw new Error("先に返送された構成品の現物を確認してください。");
      if (input.event === "END" || input.event === "RETURN_RECEIVED") {
        const reservations = await tx.inventoryReservation.findMany({
          where: { listingId: listing.id, status: "RESERVED" },
        });
        if (input.event === "RETURN_RECEIVED") {
          if (
            input.dispositions.length !== reservations.length ||
            new Set(input.dispositions.map((d) => d.reservationId)).size !== reservations.length ||
            reservations.some((r) => !input.dispositions.some((d) => d.reservationId === r.id))
          )
            throw new Error(
              "確保した構成品すべての現物状態を選択してください。未返送があれば返送確認待ちを維持してください。",
            );
          const operation = await tx.inventoryOperation.create({
            data: {
              ...scope(c),
              operatorId: c.operatorId,
              operationType: "SALE_RETURN",
              sourceType: "listing",
              sourceId: listing.id,
              idempotencyKey: input.idempotencyKey,
              occurredAt: instant(input.date),
              note: input.reason,
            },
          });
          for (const r of reservations) {
            const disposition = input.dispositions.find(
              (d) => d.reservationId === r.id,
            )!.disposition;
            if (disposition === "RESTOCK") {
              await tx.inventoryReservation.update({
                where: { id: r.id },
                data: { status: "RELEASED" },
              });
              if (r.uniqueStockUnitId)
                await tx.uniqueStockUnit.update({
                  where: { id: r.uniqueStockUnitId },
                  data: { status: "IN_STOCK" },
                });
              continue;
            }
            const unit = r.uniqueStockUnitId
              ? await tx.uniqueStockUnit.findUniqueOrThrow({ where: { id: r.uniqueStockUnitId } })
              : null;
            const lotId = unit?.inventoryLotId ?? r.inventoryLotId!;
            const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
              where: {
                itemVariantId_businessUnitId_trackingMode: {
                  itemVariantId: r.itemVariantId,
                  businessUnitId: c.businessUnitId,
                  trackingMode: unit ? "UNIQUE" : "QUANTITY",
                },
              },
            });
            const cost =
              unit?.acquisitionCostJpy ??
              movingAverageOutCost(balance.carryingCostTotalJpy, balance.quantity, r.quantity);
            const quantity = balance.quantity - r.quantity,
              total = balance.carryingCostTotalJpy - cost;
            await tx.inventoryCostBalance.update({
              where: { id: balance.id },
              data: {
                quantity,
                carryingCostTotalJpy: total,
                averageUnitCostJpy: quantity ? averageUnitCost(total, quantity) : "0",
              },
            });
            await tx.inventoryLot.update({
              where: { id: lotId },
              data: { remainingQuantity: { decrement: r.quantity } },
            });
            if (unit)
              await tx.uniqueStockUnit.update({
                where: { id: unit.id },
                data: {
                  status:
                    disposition === "DEFECTIVE"
                      ? "RETURNED"
                      : disposition === "LOST"
                        ? "LOST"
                        : "DISPOSED",
                },
              });
            await tx.inventoryReservation.update({
              where: { id: r.id },
              data: { status: "CONSUMED" },
            });
            const common = {
              operationId: operation.id,
              itemVariantId: r.itemVariantId,
              inventoryLotId: lotId,
              uniqueStockUnitId: unit?.id,
              movementAt: instant(input.date),
              businessUnitId: c.businessUnitId,
              sourceType: "listing",
              sourceId: listing.id,
              operatorId: c.operatorId,
              note: input.reason,
            };
            await tx.stockMovement.create({
              data: {
                ...common,
                movementType: disposition === "LOST" ? "LOSS" : "ADJUSTMENT_OUT",
                quantity: -r.quantity,
                costTotalJpy: -cost,
                storageLocationFromId: r.storageLocationId,
                idempotencyKey: `${input.idempotencyKey}:${r.id}:out`,
              },
            });
            if (disposition !== "LOST")
              await tx.stockMovement.create({
                data: {
                  ...common,
                  movementType:
                    disposition === "DEFECTIVE" ? "RETURN_DEFECTIVE" : "RETURN_DISPOSAL",
                  quantity: r.quantity,
                  costTotalJpy: cost,
                  storageLocationToId: r.storageLocationId,
                  idempotencyKey: `${input.idempotencyKey}:${r.id}:disposition`,
                },
              });
          }
        } else {
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
      }
      await tx.listing.update({
        where: { id: listing.id },
        data: {
          status:
            input.event === "PAUSE"
              ? "PAUSED"
              : ["END", "RETURN_RECEIVED"].includes(input.event)
                ? "ENDED"
                : "ACTIVE",
          returnPending: input.event === "RETURN_PENDING",
          revision: { increment: 1 },
          ...(["END", "RETURN_RECEIVED"].includes(input.event) ? { reservedQuantity: 0 } : {}),
        },
      });
    }
    return {
      id: listing.id,
      detail: {
        before: {
          status: listing.status,
          workflowVersion: listing.workflowVersion,
          listedQuantity: listing.listedQuantity,
        },
        reason: input.reason,
        goodsInHand: input.goodsInHand,
      },
    };
  });
}

export async function recordPrice(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof priceRecordSchema>,
) {
  return run(db, c, input, "PRICE", input.date, async (tx) => {
    const listing = await scopedListing(tx, c, input.listingId, input.revision);
    if (listing.completion || listing.status === "ENDED")
      throw new Error(
        "完了・終了した出品の価格は変更できません。実績金額は完了実績から訂正してください。",
      );
    await tx.listingPriceHistory.create({
      data: {
        listingId: listing.id,
        priceJpy: input.price,
        effectiveAt: instant(input.date),
        operatorId: c.operatorId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await tx.listing.update({
      where: { id: listing.id },
      data: { currentPriceJpy: input.price, revision: { increment: 1 } },
    });
    return {
      id: listing.id,
      detail: { before: listing.currentPriceJpy, after: input.price, reason: input.reason },
    };
  });
}

export async function recordRefund(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof refundRecordSchema>,
) {
  return run(db, c, input, "REFUND", input.date, async (tx) => {
    await lock(tx, `order:${input.orderId}`);
    const order = await tx.salesOrder.findFirst({
      where: { id: input.orderId, ...scope(c) },
      include: { returns: true },
    });
    if (!order?.completedAt || !["COMPLETED", "RETURNED"].includes(order.status))
      throw new Error("完了実績から返金を記録してください。");
    if (instant(input.date) < order.completedAt)
      throw new Error("返金日は完了日以後を指定してください。");
    if (order.revision !== input.revision)
      throw new Error("別操作で更新済みです。返金履歴を再確認してください。");
    if (
      order.completedAt.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 4) !==
      String(c.year)
    )
      throw new Error("年度をまたぐ返品・返金は直接記録できません。");
    if (
      order.returns.reduce((s, r) => s + r.salesRefundJpy, 0n) + input.salesRefund >
      order.grossSalesJpy - order.discountJpy
    )
      throw new Error("売上返金の累計が取引金額を超えています。過去の返金を確認してください。");
    await tx.salesReturn.create({
      data: {
        salesOrderId: order.id,
        returnedAt: instant(input.date),
        salesRefundJpy: input.salesRefund,
        feeRefundJpy: input.feeRefund,
        shippingRefundJpy: input.shippingRefund,
        memo: `現物移動なし：${input.reason}`,
        requestKey: input.idempotencyKey,
      },
    });
    await tx.salesOrder.update({ where: { id: order.id }, data: { revision: { increment: 1 } } });
    return { id: order.id, detail: { inventoryChanged: false, reason: input.reason } };
  });
}

export async function amendAmounts(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.output<typeof amountAmendSchema>,
) {
  return run(db, c, input, "AMEND", input.date, async (tx) => {
    await lock(tx, `order:${input.orderId}`);
    const order = await tx.salesOrder.findFirst({
      where: { id: input.orderId, ...scope(c), reportingEntityId: c.reportingEntityId },
      include: { lines: true, returns: true },
    });
    if (!order || !order.completedAt || !["COMPLETED", "RETURNED"].includes(order.status))
      throw new Error("完了実績が見つかりません。");
    if (order.revision !== input.revision)
      throw new Error("別端末で金額が更新されました。再読み込みして差分を確認してください。");
    if (instant(input.date) < order.completedAt)
      throw new Error("訂正日は完了日以後を指定してください。");
    if (
      input.actualPrice - order.discountJpy <
      order.returns.reduce((sum, r) => sum + r.salesRefundJpy, 0n)
    )
      throw new Error("訂正後の取引金額が返金累計を下回ります。返金履歴を確認してください。");
    if (
      order.completedAt.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 4) !==
      String(c.year)
    )
      throw new Error("年度をまたぐ訂正はできません。元取引の年度を確認してください。");
    await tx.salesOrder.update({
      where: { id: order.id },
      data: {
        grossSalesJpy: input.actualPrice,
        feeJpy: input.fee,
        shippingJpy: input.shipping,
        packingJpy: input.packing,
        otherCostJpy: input.other,
        revision: { increment: 1 },
      },
    });
    if (order.completionListingId)
      await tx.salesOrderLine.updateMany({
        where: { salesOrderId: order.id },
        data: { unitPriceJpy: input.actualPrice },
      });
    return {
      id: order.id,
      detail: {
        before: {
          gross: order.grossSalesJpy,
          fee: order.feeJpy,
          shipping: order.shippingJpy,
          packing: order.packingJpy,
          other: order.otherCostJpy,
        },
        reason: input.reason,
        inventoryChanged: false,
      },
    };
  });
}
