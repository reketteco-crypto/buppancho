import { recordCatalogEdit } from "./catalog-edit";
import { checkWorkflowContext } from "@/lib/sales/workflow-context";
import { catalogStocks, catalogSelectionNames } from "./catalog";
import { recordOther, recordCategory } from "./other-records";
import { skuMaterialQuote, recordMaterialUse } from "./supplies";
import { recordAccount, recordMoney, executeMoney } from "./money";
import { recordPurchaseReturn } from "./purchase-return";
import { cancelPurchase } from "./purchase-cancel";
import { randomUUID } from "node:crypto";
import { calculatePurchase, PurchaseCalculationError } from "./purchase-calculation";
import { rebaseCommerceDraft } from "./drafts";
import { receiptPlan } from "./receipt-delivery";
import { recordDelivery, recordPurchaseCost } from "./cost-workflow";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { z } from "zod";
import { runWorkflow, type WorkflowHooks } from "@/lib/sales/workflow-runner";
import { saleRecordId } from "./sale-ids";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { nextWorkspaceCode } from "@/lib/inventory/codes";
import { averageUnitCost, movingAverageOutCost } from "@/lib/inventory/money";
import { plannedMovementCost, plannedOperationOrder } from "@/lib/inventory/valuation-session";
import { effectiveLotReceiptDates } from "@/lib/inventory/event-dates";
import { toJson } from "@/lib/sales/request-store";
import { lotLocations } from "@/lib/sales/workflow";
import { allocateYen, Precise } from "./allocation";
import {
  supplierConfigSchema,
  buySchema,
  receiveSchema,
  saleSchema,
  skuSchema,
  skuBatchSchema,
  methodSchema,
  channelSchema,
  type CommerceKind,
} from "./input";

type Tx = Prisma.TransactionClient;
export const commerceScope = (c: WorkflowContext) => ({
  workspaceId: c.workspaceId,
  businessUnitId: c.businessUnitId,
});
const dateOnly = (date: string) => new Date(`${date}T00:00:00Z`);
const instant = (date: string) => new Date(`${date}T00:00:00+09:00`);
const yenOrNull = (value: string) => (value === "" ? null : BigInt(value));
function fail(message: string): never {
  throw new WorkflowError("VALIDATION", message);
}
function conflict(): never {
  throw new WorkflowError(
    "CONFLICT",
    "別の操作で更新されました。入力を保持して最新の内容を確認してください。",
  );
}

async function locationFor(tx: Tx, c: WorkflowContext, id: string) {
  const location = await tx.storageLocation.findFirst({
    where: {
      id,
      workspaceId: c.workspaceId,
      active: true,
      OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
    },
  });
  if (!location) fail("保管場所を確認してください。");
  return location;
}

async function finishDraft(
  tx: Tx,
  c: WorkflowContext,
  input: { draftId: string; draftRevision: number },
  kind: string,
  targetId: string,
) {
  const draft = await tx.workflowDraft.findUnique({ where: { id: input.draftId } });
  if (draft) {
    if (
      draft.workspaceId !== c.workspaceId ||
      draft.businessUnitId !== c.businessUnitId ||
      draft.operatorId !== c.operatorId ||
      draft.year !== c.year ||
      draft.kind !== kind ||
      draft.archivedAt ||
      draft.revision !== input.draftRevision
    )
      conflict();
    const original = draft.baseSnapshot as { reportingEntityId?: string } | null;
    if (original?.reportingEntityId && original.reportingEntityId !== c.reportingEntityId)
      throw new WorkflowError("OWNERSHIP_CHANGED", "入力開始時の帰属が変更されています。");
    await tx.workflowDraft.update({ where: { id: draft.id }, data: { archivedAt: new Date() } });
  } else {
    if (input.draftRevision !== 0) conflict();
    await tx.workflowDraft.create({
      data: {
        id: input.draftId,
        ...commerceScope(c),
        operatorId: c.operatorId,
        year: c.year,
        kind,
        baseSnapshot: { reportingEntityId: c.reportingEntityId },
        payload: { targetId },
        archivedAt: new Date(),
      },
    });
  }
}

export function purchaseCalculation(input: z.infer<typeof buySchema>) {
  try {
    return calculatePurchase(input);
  } catch (e) {
    throw new WorkflowError(
      "VALIDATION",
      e instanceof PurchaseCalculationError ? e.message : "Calculation failed",
    );
  }
}

async function createVariant(
  tx: Tx,
  c: WorkflowContext,
  name: string,
  trackingMode: "QUANTITY" | "UNIQUE",
  locationId: string,
  id: string,
) {
  const itemCode = await nextWorkspaceCode(tx, c.workspaceId, "ITEM");
  const variantCode = await nextWorkspaceCode(tx, c.workspaceId, "VARIANT");
  const item = await tx.inventoryItem.create({
    data: {
      ...commerceScope(c),
      itemCode,
      name,
      managementType: trackingMode,
      managementCostMethod: trackingMode === "QUANTITY" ? "MOVING_AVERAGE" : "SPECIFIC",
      defaultStorageLocationId: locationId,
    },
  });
  return tx.itemVariant.create({
    data: { id, workspaceId: c.workspaceId, inventoryItemId: item.id, variantCode },
  });
}

export async function createReceipt(
  tx: Tx,
  c: WorkflowContext,
  key: string,
  date: string,
  locationId: string,
  entries: { lineId: string; quantity: number; deliveryLineId?: string }[],
) {
  await locationFor(tx, c, locationId);
  const sourceLines = await tx.purchaseDocumentLine.findMany({
    where: { id: { in: entries.map((e) => e.lineId) }, document: commerceScope(c) },
    include: { document: true, receipts: true },
    orderBy: [{ documentId: "asc" }, { position: "asc" }],
  });
  if (sourceLines.length !== entries.length) fail("受け取る商品を確認してください。");
  if (sourceLines.some((l) => l.document.reportingEntityId !== c.reportingEntityId))
    throw new WorkflowError("OWNERSHIP_CHANGED", "購入時と現在の帰属が異なります。");
  if (
    sourceLines.some(
      (l) => l.document.status === "CANCELLED" || l.document.purchasedDate > dateOnly(date),
    )
  )
    fail("受取日は購入日以降を指定してください。");
  const operation = sourceLines.some((l) => l.purpose === "STOCK")
    ? await tx.inventoryOperation.create({
        data: {
          ...commerceScope(c),
          operatorId: c.operatorId,
          operationType: "PURCHASE_RECEIPT",
          sourceType: "purchase_receipt",
          sourceId: key,
          occurredAt: instant(date),
          valuationOrder: plannedOperationOrder(),
          idempotencyKey: key,
        },
      })
    : null;
  const receipt = await tx.purchaseReceipt.create({
    data: {
      ...commerceScope(c),
      reportingEntityId: c.reportingEntityId,
      receivedDate: dateOnly(date),
      storageLocationId: locationId,
      operationId: operation?.id,
      requestKey: key,
    },
  });
  for (const [index, source] of sourceLines.entries()) {
    const entry = entries.find((e) => e.lineId === source.id)!;
    const quantity = entry.quantity;
    if (entry.deliveryLineId) {
      const shipped = await tx.inboundDeliveryLine.findFirst({
        where: {
          id: entry.deliveryLineId,
          purchaseLineId: source.id,
          delivery: {
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            reportingEntityId: c.reportingEntityId,
          },
        },
        include: { delivery: true, receipts: true, receiptLinks: true },
      });
      if (
        !shipped ||
        quantity >
          shipped.quantity -
            shipped.receipts.reduce((s, r) => s + r.quantity, 0) -
            shipped.receiptLinks.reduce((s, r) => s + r.quantity, 0)
      )
        fail("配送分の未受取数量を超えています。");
      if (shipped.delivery.shippedDate > dateOnly(date))
        fail("受取日は配送日以降を指定してください。");
    }
    if (quantity > source.quantity - source.receivedQuantity)
      fail("注文数を超えて受け取ることはできません。");
    if (source.purpose !== "STOCK") {
      const pendingId = randomUUID(),
        plan = await receiptPlan(tx, source.id, {
          id: pendingId,
          quantity,
          deliveryLineId: entry.deliveryLineId,
        });
      await tx.purchaseReceiptLine.create({
        data: {
          receiptId: receipt.id,
          lineId: source.id,
          quantity,
          costJpy: plan.get(pendingId)!,
          deliveryLineId: entry.deliveryLineId,
        },
      });
      await tx.purchaseDocumentLine.update({
        where: { id: source.id },
        data: { receivedQuantity: { increment: quantity } },
      });
      continue;
    }
    if (!source.itemVariantId) fail("在庫商品の情報がありません。");
    const variant = await tx.itemVariant.findFirst({
      where: {
        id: source.itemVariantId,
        workspaceId: c.workspaceId,
        inventoryItem: { businessUnitId: c.businessUnitId, status: "ACTIVE" },
      },
    });
    if (!variant) fail("在庫商品の部門を確認してください。");
    const pendingId = randomUUID();
    const plan = await receiptPlan(tx, source.id, {
      id: pendingId,
      quantity,
      deliveryLineId: entry.deliveryLineId,
    });
    const cost = plan.get(pendingId)!;
    if (cost < 0n) fail("受取原価を確認してください。");
    const mode: "UNIQUE" | "QUANTITY" = source.trackingMode === "UNIQUE" ? "UNIQUE" : "QUANTITY";
    const lot = await tx.inventoryLot.create({
      data: {
        itemVariantId: source.itemVariantId,
        trackingMode: mode,
        receivedDate: dateOnly(date),
        receivedQuantity: quantity,
        remainingQuantity: quantity,
        landedCostTotalJpy: cost,
        unitCostJpy: averageUnitCost(cost, quantity),
        costStatus: source.document.costFinal ? "FINAL" : "PROVISIONAL",
        storageLocationId: locationId,
      },
    });
    let unitId: string | undefined;
    if (mode === "UNIQUE") {
      if (quantity !== 1) fail("1点ものは1点ずつ受け取ってください。");
      const unit = await tx.uniqueStockUnit.create({
        data: {
          workspaceId: c.workspaceId,
          itemVariantId: source.itemVariantId,
          inventoryLotId: lot.id,
          individualCode: await nextWorkspaceCode(tx, c.workspaceId, "UNIT"),
          condition: "未記入",
          acquisitionCostJpy: cost,
          storageLocationId: locationId,
        },
      });
      unitId = unit.id;
    }
    await tx.purchaseReceiptLine.create({
      data: {
        deliveryLineId: entries.find((e) => e.lineId === source.id)?.deliveryLineId,
        receiptId: receipt.id,
        lineId: source.id,
        inventoryLotId: lot.id,
        quantity,
        costJpy: cost,
      },
    });
    await tx.stockMovement.create({
      data: {
        operationId: operation!.id,
        itemVariantId: source.itemVariantId,
        inventoryLotId: lot.id,
        uniqueStockUnitId: unitId,
        movementType: "RECEIPT",
        quantity,
        costTotalJpy: cost,
        movementAt: instant(date),
        businessUnitId: c.businessUnitId,
        storageLocationToId: locationId,
        sourceType: "purchase_receipt",
        sourceId: receipt.id,
        idempotencyKey: `${key}:${index}`,
        operatorId: c.operatorId,
      },
    });
    const where = {
      itemVariantId_businessUnitId_trackingMode: {
        itemVariantId: source.itemVariantId,
        businessUnitId: c.businessUnitId,
        trackingMode: mode,
      },
    };
    const balance = await tx.inventoryCostBalance.findUnique({ where });
    const nextQuantity = (balance?.quantity ?? 0) + quantity,
      nextCost = (balance?.carryingCostTotalJpy ?? 0n) + cost;
    await tx.inventoryCostBalance.upsert({
      where,
      create: {
        itemVariantId: source.itemVariantId,
        businessUnitId: c.businessUnitId,
        trackingMode: mode,
        quantity: nextQuantity,
        carryingCostTotalJpy: nextCost,
        averageUnitCostJpy: averageUnitCost(nextCost, nextQuantity),
      },
      update: {
        quantity: nextQuantity,
        carryingCostTotalJpy: nextCost,
        averageUnitCostJpy: averageUnitCost(nextCost, nextQuantity),
      },
    });
    await tx.purchaseDocumentLine.update({
      where: { id: source.id },
      data: { receivedQuantity: { increment: quantity } },
    });
  }
  for (const id of new Set(sourceLines.map((l) => l.documentId))) {
    const remaining = await tx.purchaseDocumentLine.findMany({ where: { documentId: id } });
    await tx.purchaseDocument.update({
      where: { id },
      data: {
        status: remaining.every((l) => l.receivedQuantity === l.quantity)
          ? "RECEIVED"
          : "PARTIALLY_RECEIVED",
      },
    });
  }
  const deliveryIds = await tx.inboundDeliveryLine.findMany({
    where: {
      id: { in: entries.flatMap((e) => (e.deliveryLineId ? [e.deliveryLineId] : [])) },
      delivery: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
    },
    select: { deliveryId: true },
  });
  for (const id of new Set(deliveryIds.map((l) => l.deliveryId)))
    await tx.inboundDelivery.update({ where: { id }, data: { revision: { increment: 1 } } });
  return receipt;
}

export async function recordBuy(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof buySchema>,
) {
  return runWorkflow(db, c, input, "BUY", input.date, async (tx) => {
    await locationFor(tx, c, input.locationId);
    const totals = purchaseCalculation(input);
    let supplier = input.supplierId
      ? await tx.counterparty.findFirst({
          where: { id: input.supplierId, workspaceId: c.workspaceId, active: true },
        })
      : await tx.counterparty.findFirst({
          where: { workspaceId: c.workspaceId, name: input.supplierName, type: "SUPPLIER" },
        });
    if (
      input.supplierId &&
      (!supplier ||
        (input.supplierRevision !== undefined && supplier.revision !== input.supplierRevision))
    )
      conflict();
    supplier ??= await tx.counterparty.create({
      data: { workspaceId: c.workspaceId, name: input.supplierName, type: "SUPPLIER" },
    });
    const document = await tx.purchaseDocument.create({
      data: {
        ...commerceScope(c),
        reportingEntityId: c.reportingEntityId,
        supplierId: supplier.id,
        supplierName: supplier.name,
        code: await nextWorkspaceCode(tx, c.workspaceId, "PURCHASE"),
        purchasedDate: dateOnly(input.date),
        totalJpy: totals.total,
        currency: totals.currency,
        exchangeRate: totals.rate,
        rateBasis: totals.rateBasis,
        actualOrderJpy: input.actualOrderJpy ? BigInt(input.actualOrderJpy) : null,
        externalReference: input.externalReference || null,
        importSource: input.importSource ? toJson(input.importSource) : undefined,
        costFinal: totals.final,
        taxMode: input.taxMode,
        taxAmountJpy: yenOrNull(input.taxAmount),
        memo: input.memo || null,
        requestKey: input.idempotencyKey,
        sourceDraftId: input.draftId,
      },
    });
    const ids = new Map<string, string>();
    for (const [index, row] of input.lines.entries()) {
      const purpose = row.purpose || "STOCK";
      let supplyItemId: string | null = null;
      let variantId: string | null = null;
      if (purpose !== "STOCK") {
        if (row.variantId) fail("資材・備品には在庫商品を指定できません。");
        let supply = row.supplyItemId
          ? await tx.supplyItem.findFirst({
              where: { id: row.supplyItemId, ...commerceScope(c), kind: purpose, active: true },
            })
          : await tx.supplyItem.findFirst({
              where: { ...commerceScope(c), kind: purpose, name: row.name, active: true },
            });
        if (row.supplyItemId && !supply) fail("選択した資材・備品を使用できません。");
        supply ??= await tx.supplyItem.create({
          data: {
            id: row.clientId,
            ...commerceScope(c),
            kind: purpose,
            name: row.name,
            unit: row.supplyUnit || "点",
          },
        });
        supplyItemId = supply.id;
      } else {
        variantId = row.variantId || null;
        if (variantId) {
          const variant = await tx.itemVariant.findFirst({
            where: {
              id: variantId,
              workspaceId: c.workspaceId,
              active: true,
              inventoryItem: { businessUnitId: c.businessUnitId, status: "ACTIVE" },
            },
            include: { inventoryItem: { select: { managementType: true } } },
          });
          if (!variant) fail("選択した商品を使用できません。");
          if (variant.inventoryItem.managementType !== row.trackingMode)
            fail("登録済み商品の管理方法と一致しません。商品を選び直してください。");
        } else
          variantId = (
            await createVariant(tx, c, row.name, row.trackingMode, input.locationId, row.clientId)
          ).id;
      }
      const line = await tx.purchaseDocumentLine.create({
        data: {
          documentId: document.id,
          position: index,
          itemVariantId: variantId,
          supplyItemId,
          purpose,
          name: row.name,
          trackingMode: purpose === "STOCK" ? row.trackingMode : "NONE",
          sourceName: row.sourceName || null,
          quantity: row.quantity,
          amount: row.amount,
          priceBasis: row.priceBasis,
          productAmountJpy: totals.amounts[index]!,
          landedCostJpy: totals.landed[index]!,
          weightG: row.weight || null,
          volumeCm3: row.volume || null,
        },
      });
      ids.set(row.clientId, line.id);
    }
    for (const row of totals.allocations) {
      await tx.purchaseCharge.create({
        data: {
          recordedDate: dateOnly(input.date),
          documentId: document.id,
          name: row.charge.name,
          amountJpy: row.amountJpy,
          amountForeign: row.charge.amount || null,
          currency: row.charge.currency || totals.currency,
          exchangeRate:
            row.charge.exchangeRate ||
            ((row.charge.currency || totals.currency) === "JPY" ? "1" : totals.rate),
          rateBasis: row.charge.actualJpy
            ? "ACTUAL"
            : (row.charge.currency || totals.currency) === "JPY"
              ? "JPY"
              : totals.rateBasis,
          allocationMethod: row.charge.method,
          capitalized: row.charge.capitalized,
          allocated: row.allocations !== null,
          basisSnapshot: toJson({
            targets: input.lines
              .filter((l) => !row.charge.lineIds.length || row.charge.lineIds.includes(l.clientId))
              .map((l) => ids.get(l.clientId)!),
            bases: Object.fromEntries(
              input.lines
                .filter(
                  (l) => !row.charge.lineIds.length || row.charge.lineIds.includes(l.clientId),
                )
                .map((l) => [
                  ids.get(l.clientId)!,
                  {
                    weight: l.weight || "",
                    volume: l.volume || "",
                    manual: row.charge.manual[l.clientId] ?? "",
                  },
                ]),
            ),
          }),
          allocations: {
            create: (row.allocations ?? []).map((a) => ({
              lineId: ids.get(a.lineId)!,
              amountJpy: a.amount,
            })),
          },
        },
      });
    }
    if (input.received)
      await createReceipt(
        tx,
        c,
        input.idempotencyKey,
        input.date,
        input.locationId,
        input.lines.map((l) => ({ lineId: ids.get(l.clientId)!, quantity: l.quantity })),
      );
    const skuIds: string[] = [];
    if (input.createSkus) {
      if (!input.received) fail("購入時に単品SKUを作成する場合は、受取済みにしてください。");
      const rows = await tx.purchaseDocumentLine.findMany({
        where: { documentId: document.id, purpose: "STOCK" },
        orderBy: { position: "asc" },
        include: {
          receipts: { include: { inventoryLot: { include: { uniqueStockUnits: true } } } },
        },
      });
      for (const row of rows) {
        const unitId =
          row.trackingMode === "UNIQUE"
            ? row.receipts[0]?.inventoryLot?.uniqueStockUnits[0]?.id
            : null;
        if (row.trackingMode === "UNIQUE" && !unitId) fail("受取した個体を確認できません。");
        skuIds.push(
          await singleSku(tx, c, {
            name: row.name,
            variantId: unitId ? null : row.itemVariantId,
            unitId: unitId ?? null,
          }),
        );
      }
    }
    if (input.payment && input.payment.method !== "NONE") {
      await checkWorkflowContext(tx, c, input.payment.date);
      const current = await tx.purchaseDocument.findUniqueOrThrow({ where: { id: document.id } });
      await executeMoney(tx, c, {
        idempotencyKey: input.idempotencyKey,
        context: input.context,
        date: input.payment.date,
        kind: "PURCHASE_PAYMENT",
        sourceId: document.id,
        sourceRevision: current.revision,
        amount: input.payment.amount,
        fee: "",
        accountId: input.payment.accountId,
        accountRevision: input.payment.accountRevision,
        toAccountId: "",
        toAccountRevision: 0,
        paymentMethod: input.payment.method,
        memo: "",
      });
    }
    await finishDraft(tx, c, input, "COMMERCE_PURCHASE", document.id);
    return {
      id: document.id,
      detail: {
        code: document.code,
        total: totals.total.toString(),
        received: input.received,
        skuIds: [...new Set(skuIds)],
      },
    };
  });
}

export async function recordReceipt(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof receiveSchema>,
) {
  return runWorkflow(db, c, input, "RECEIVE", input.date, async (tx) => {
    const document = await tx.purchaseDocument.findFirst({
      where: { id: input.purchaseId, ...commerceScope(c) },
      include: { lines: true },
    });
    if (!document || document.revision !== input.revision) conflict();
    if (input.lines.some((l) => !document.lines.some((source) => source.id === l.lineId)))
      fail("購入に含まれない明細です。");
    await createReceipt(tx, c, input.idempotencyKey, input.date, input.locationId, input.lines);
    return { id: document.id, detail: { receivedLines: input.lines.length } };
  });
}

async function validateComponents(
  tx: Tx,
  c: WorkflowContext,
  components: z.infer<typeof skuSchema>["components"],
) {
  for (const component of components) {
    if (component.uniqueStockUnitId) {
      if (
        !(await tx.uniqueStockUnit.findFirst({
          where: {
            id: component.uniqueStockUnitId,
            workspaceId: c.workspaceId,
            itemVariant: { inventoryItem: { businessUnitId: c.businessUnitId } },
          },
        }))
      )
        fail("1点ものの商品を確認してください。");
    } else if (
      !(await tx.itemVariant.findFirst({
        where: {
          id: component.itemVariantId!,
          workspaceId: c.workspaceId,
          active: true,
          inventoryItem: { businessUnitId: c.businessUnitId, status: "ACTIVE" },
        },
      }))
    )
      fail("構成商品を確認してください。");
  }
}

async function createSku(
  tx: Tx,
  c: WorkflowContext,
  name: string,
  components: z.infer<typeof skuSchema>["components"],
  key: string,
  price?: bigint | null,
) {
  await validateComponents(tx, c, components);
  return tx.salesSku.create({
    data: {
      ...commerceScope(c),
      skuCode: await nextWorkspaceCode(tx, c.workspaceId, "SALES_SKU"),
      name,
      skuType:
        components.length === 1 && components[0]!.requiredQuantity === 1 ? "SINGLE" : "BUNDLE",
      expectedPriceJpy: price,
      requestKey: key,
      components: { create: components },
    },
  });
}

export async function recordSku(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof skuSchema>,
) {
  return runWorkflow(db, c, input, "SKU_SAVE", input.date, async (tx) => {
    await validateComponents(tx, c, input.components);
    const supplies = input.supplies ?? [];
    if (
      new Set(supplies.map((s) => `${s.supplyItemId}:${s.purpose}`)).size !== supplies.length ||
      supplies.some((s) => new Precise(s.quantity).lte(0)) ||
      (await tx.supplyItem.count({
        where: {
          id: { in: [...new Set(supplies.map((s) => s.supplyItemId))] },
          ...commerceScope(c),
          kind: "MATERIAL",
          active: true,
        },
      })) !== new Set(supplies.map((s) => s.supplyItemId)).size
    )
      fail("使用する資材と数量を確認してください。");
    const channelIds = input.channels.map((r) => r.channelId);
    if (
      (await tx.salesChannel.count({
        where: { id: { in: channelIds }, workspaceId: c.workspaceId, active: true },
      })) !== channelIds.length
    )
      fail("販路を確認してください。");
    const methods = [
      ...new Set(input.channels.flatMap((r) => (r.deliveryMethodId ? [r.deliveryMethodId] : []))),
    ];
    if (
      (await tx.deliveryMethod.count({
        where: { id: { in: methods }, workspaceId: c.workspaceId, active: true },
      })) !== methods.length
    )
      fail("配送方法を確認してください。");
    const previous = input.id
      ? await tx.salesSku.findFirst({ where: { id: input.id, ...commerceScope(c), active: true } })
      : null;
    if (input.id && (!previous || previous.revision !== input.revision)) conflict();
    const sku = previous
      ? await tx.salesSku.update({
          where: { id: previous.id },
          data: {
            name: input.name,
            expectedPriceJpy: yenOrNull(input.price),
            skuType:
              input.components.length === 1 && input.components[0]!.requiredQuantity === 1
                ? "SINGLE"
                : "BUNDLE",
          },
        })
      : await createSku(
          tx,
          c,
          input.name,
          input.components,
          input.idempotencyKey,
          yenOrNull(input.price),
        );
    if (previous) {
      await tx.salesSkuComponent.deleteMany({ where: { salesSkuId: sku.id } });
      await tx.salesSkuComponent.createMany({
        data: input.components.map((r) => ({ salesSkuId: sku.id, ...r })),
      });
      await tx.skuChannelSetting.deleteMany({ where: { salesSkuId: sku.id } });
    }
    if (input.channels.length)
      await tx.skuChannelSetting.createMany({
        data: input.channels.map((row) => ({
          salesSkuId: sku.id,
          salesChannelId: row.channelId,
          priceJpy: yenOrNull(row.price),
          shippingJpy: yenOrNull(row.shipping),
          deliveryMethodId: row.deliveryMethodId || null,
        })),
      });
    await tx.skuSupplySetting.deleteMany({ where: { skuId: sku.id } });
    if (supplies.length)
      await tx.skuSupplySetting.createMany({
        data: supplies.map((s) => ({
          skuId: sku.id,
          supplyItemId: s.supplyItemId,
          purpose: s.purpose,
          quantity: s.quantity,
          unitCostJpy: s.unitCost || null,
        })),
      });
    return { id: sku.id, detail: { name: sku.name } };
  });
}

async function singleSku(
  tx: Tx,
  c: WorkflowContext,
  row: { name: string; variantId: string | null; unitId: string | null },
) {
  const match = {
    itemVariantId: row.variantId,
    uniqueStockUnitId: row.unitId,
    requiredQuantity: 1,
  };
  const existing = await tx.salesSku.findFirst({
    where: {
      ...commerceScope(c),
      active: true,
      skuType: "SINGLE",
      components: { some: match, every: match },
    },
  });
  return existing?.id ?? (await createSku(tx, c, row.name, [match], randomUUID())).id;
}
export async function recordSkuBatch(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof skuBatchSchema>,
) {
  return runWorkflow(db, c, input, "SKU_BATCH", input.date, async (tx) => {
    const skus: string[] = [];
    const selected = input.selection ? await catalogStocks(tx, c, { ids: input.selection }) : null;
    if (selected && selected.rows.length !== input.selection!.length) {
      const missing = input.selection!.filter((id) => !selected.rows.some((row) => row.id === id)),
        names = await catalogSelectionNames(tx, c, missing);
      fail(
        `利用できない商品があります。選択内容から解除してください。 ${missing
          .slice(0, 5)
          .map((id) => {
            const row = names.find((r) => r.id === id);
            return row ? `${row.name}（${row.label}）` : id;
          })
          .join("、")}${missing.length > 5 ? ` ほか${missing.length - 5}件` : ""}`,
      );
    }
    const rows = selected
      ? selected.rows.map((p) => ({ name: p.name, variantId: p.variantId, unitId: p.unitId }))
      : input.products!;
    for (const row of rows) {
      await validateComponents(tx, c, [
        { itemVariantId: row.variantId, uniqueStockUnitId: row.unitId, requiredQuantity: 1 },
      ]);
      skus.push(await singleSku(tx, c, row));
    }
    return { id: skus[0]!, detail: { skuIds: skus } };
  });
}

export async function recordSale(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof saleSchema>,
  hooks?: WorkflowHooks,
) {
  return runWorkflow(
    db,
    c,
    input,
    "SALE",
    input.date,
    (tx) => recordSaleTransaction(tx, c, input),
    hooks,
  );
}

export async function recordSaleTransaction(
  tx: Tx,
  c: WorkflowContext,
  input: z.infer<typeof saleSchema>,
) {
  const sku = await tx.salesSku.findFirst({
    where: { id: input.skuId, ...commerceScope(c), active: true },
    include: { components: { orderBy: { id: "asc" } } },
  });
  const channel = await tx.salesChannel.findFirst({
    where: { id: input.channelId, workspaceId: c.workspaceId, active: true },
  });
  if (
    !sku ||
    !channel ||
    sku.revision !== input.skuRevision ||
    channel.revision !== input.channelRevision
  )
    conflict();
  if (!sku.components.length) fail("SKUの構成商品がありません。");
  const materials = await skuMaterialQuote(
    tx,
    c,
    sku.id,
    input.quantity,
    input.date,
    input.supplyQuantities,
  );
  if (
    materials.quote.length &&
    JSON.stringify(materials.quote) !== JSON.stringify(input.materialQuote)
  )
    throw new WorkflowError("CONFLICT", "資材の単価候補を再確認してください。");
  if (
    input.deliveryMethodId &&
    !(await tx.deliveryMethod.findFirst({
      where: { id: input.deliveryMethodId, workspaceId: c.workspaceId, active: true },
    }))
  )
    fail("配送方法を確認してください。");
  const order = await tx.salesOrder.create({
    data: {
      id: saleRecordId(input.idempotencyKey, "order"),
      ...commerceScope(c),
      reportingEntityId: c.reportingEntityId,
      salesChannelId: channel.id,
      recordingMode: "DIRECT",
      settlementSnapshot: toJson({
        feeDeducted: channel.feeDeducted,
        shippingDeducted: channel.shippingDeducted,
        receivingAccountId:
          channel.receivingAccountId &&
          (await tx.moneyAccount.findFirst({
            where: {
              id: channel.receivingAccountId,
              accountKind: { not: "OWNER_CLEARING" },
              ...commerceScope(c),
              reportingEntityId: c.reportingEntityId,
              active: true,
            },
          }))
            ? channel.receivingAccountId
            : null,
      }),
      sourceDraftId: input.draftId,
      externalOrderId: input.externalId || null,
      completedAt: instant(input.date),
      status: "COMPLETED",
      grossSalesJpy: BigInt(input.price) * BigInt(input.quantity),
      feeJpy: yenOrNull(input.fee),
      shippingJpy: yenOrNull(input.shipping),
      packingJpy: 0n,
      otherCostJpy: 0n,
      buyerName: input.buyer || null,
      memo: input.memo || null,
      requestKey: input.idempotencyKey,
      saleSnapshot: toJson({
        importSource: input.importSource,
        sku: { id: sku.id, name: sku.name, revision: sku.revision, components: sku.components },
        channel: { id: channel.id, name: channel.name, revision: channel.revision },
        deliveryMethodId: input.deliveryMethodId || null,
      }),
      lines: {
        create: {
          id: saleRecordId(input.idempotencyKey, "line"),
          salesSkuId: sku.id,
          displayName: sku.name,
          quantity: input.quantity,
          unitPriceJpy: BigInt(input.price),
        },
      },
    },
    include: { lines: true },
  });
  if (materials.uses.length)
    await tx.materialUse.createMany({
      data: materials.uses.map((m) => ({
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        reportingEntityId: c.reportingEntityId,
        saleId: order.id,
        supplyItemId: m.supplyItemId,
        supplyName: m.name,
        purchaseLineId: m.sourceLineId,
        purpose: m.purpose,
        quantity: m.quantity,
        unitCostJpy: m.unitCost || null,
        costJpy: m.cost,
        costFinal: m.final && m.unitCost !== "",
        date: dateOnly(input.date),
        requestId: input.idempotencyKey,
      })),
    });
  const operation = await tx.inventoryOperation.create({
    data: {
      id: saleRecordId(input.idempotencyKey, "operation"),
      ...commerceScope(c),
      operatorId: c.operatorId,
      operationType: "SALE_COMPLETION",
      sourceType: "sales_order",
      sourceId: order.id,
      occurredAt: instant(input.date),
      valuationOrder: plannedOperationOrder(),
      idempotencyKey: input.idempotencyKey,
    },
  });
  let total = 0n,
    final = true,
    moveIndex = 0;
  for (const component of sku.components) {
    const allocations: {
      lotId: string;
      locationId: string;
      unitId?: string;
      quantity: number;
      fallback: bigint;
      status: "FINAL" | "PROVISIONAL";
    }[] = [];
    let variantId = component.itemVariantId;
    const mode = component.uniqueStockUnitId ? "UNIQUE" : "QUANTITY";
    const needed = component.requiredQuantity * input.quantity;
    if (component.uniqueStockUnitId) {
      if (needed !== 1) fail("1点ものは1点ずつ販売してください。");
      const unit = await tx.uniqueStockUnit.findFirst({
        where: {
          id: component.uniqueStockUnitId,
          workspaceId: c.workspaceId,
          status: "IN_STOCK",
          itemVariant: { inventoryItem: { businessUnitId: c.businessUnitId } },
        },
        include: {
          inventoryLot: {
            include: {
              documentReceiptLine: { include: { receipt: true } },
              purchaseLine: { include: { purchase: true } },
            },
          },
        },
      });
      if (
        !unit ||
        (await tx.inventoryReservation.count({
          where: { uniqueStockUnitId: component.uniqueStockUnitId, status: "RESERVED" },
        }))
      )
        fail("この1点ものは販売可能な在庫にありません。");
      const entityId =
        unit.inventoryLot.documentReceiptLine?.receipt.reportingEntityId ??
        unit.inventoryLot.purchaseLine?.purchase.reportingEntityId;
      if (entityId && entityId !== c.reportingEntityId)
        throw new WorkflowError("OWNERSHIP_CHANGED", "購入時の帰属が異なります。");
      const dates = await effectiveLotReceiptDates(tx, [unit.inventoryLotId]);
      if (!dates.get(unit.inventoryLotId) || dates.get(unit.inventoryLotId)! > input.date)
        fail("完了日時点では入庫されていません。");
      variantId = unit.itemVariantId;
      allocations.push({
        lotId: unit.inventoryLotId,
        locationId: unit.storageLocationId,
        unitId: unit.id,
        quantity: 1,
        fallback: unit.acquisitionCostJpy,
        status: unit.inventoryLot.costStatus,
      });
    } else {
      const variant = await tx.itemVariant.findFirst({
        where: {
          id: variantId!,
          workspaceId: c.workspaceId,
          inventoryItem: { businessUnitId: c.businessUnitId },
        },
      });
      if (!variant) fail("SKUの構成商品の部門を確認してください。");
      const balance = await tx.inventoryCostBalance.findFirst({
        where: {
          itemVariantId: variantId!,
          businessUnitId: c.businessUnitId,
          trackingMode: "QUANTITY",
        },
      });
      if (!balance || balance.quantity < needed) fail("販売可能な在庫が不足しています。");
      const lots = await tx.inventoryLot.findMany({
        where: {
          itemVariantId: variantId!,
          trackingMode: "QUANTITY",
          remainingQuantity: { gt: 0 },
        },
        include: {
          documentReceiptLine: { include: { receipt: true } },
          purchaseLine: { include: { purchase: true } },
        },
        orderBy: [{ receivedDate: "asc" }, { id: "asc" }],
      });
      const dates = await effectiveLotReceiptDates(
        tx,
        lots.map((l) => l.id),
      );
      lots.sort(
        (a, b) =>
          (dates.get(a.id) ?? "").localeCompare(dates.get(b.id) ?? "") || a.id.localeCompare(b.id),
      );
      let left = needed;
      for (const lot of lots) {
        if (!dates.has(lot.id)) fail("入庫履歴を確認できません。");
        if (dates.get(lot.id)! > input.date) continue;
        const entityId =
          lot.documentReceiptLine?.receipt.reportingEntityId ??
          lot.purchaseLine?.purchase.reportingEntityId;
        if (entityId && entityId !== c.reportingEntityId)
          throw new WorkflowError("OWNERSHIP_CHANGED", "購入時の帰属が異なります。");
        const locations = await lotLocations(tx, lot.id);
        for (const [locationId, count] of locations) {
          const held = await tx.inventoryReservation.aggregate({
            where: { inventoryLotId: lot.id, storageLocationId: locationId, status: "RESERVED" },
            _sum: { quantity: true },
          });
          const quantity = Math.min(left, count - (held._sum.quantity ?? 0), lot.remainingQuantity);
          if (quantity <= 0) continue;
          allocations.push({
            lotId: lot.id,
            locationId,
            quantity,
            fallback: 0n,
            status: lot.costStatus,
          });
          left -= quantity;
          if (!left) break;
        }
        if (!left) break;
      }
      if (left) fail("完了日時点の販売可能な在庫が不足しています。");
      const costs = allocateYen(
        movingAverageOutCost(balance.carryingCostTotalJpy, balance.quantity, needed),
        allocations.map((a) => a.quantity),
      );
      allocations.forEach((a, i) => {
        a.fallback = costs[i]!;
      });
    }
    let componentCost = 0n;
    for (const a of allocations) {
      const moveKey = `${input.idempotencyKey}:${moveIndex++}`;
      const cost = -plannedMovementCost(moveKey, -a.fallback);
      componentCost += cost;
      final &&= a.status === "FINAL";
      await tx.inventoryLot.update({
        where: { id: a.lotId },
        data: { remainingQuantity: { decrement: a.quantity } },
      });
      if (a.unitId)
        await tx.uniqueStockUnit.update({ where: { id: a.unitId }, data: { status: "SOLD" } });
      await tx.orderComponentConsumption.create({
        data: {
          id: saleRecordId(input.idempotencyKey, `consumption:${moveKey}`),
          salesOrderLineId: order.lines[0]!.id,
          itemVariantId: variantId!,
          inventoryLotId: a.unitId ? null : a.lotId,
          uniqueStockUnitId: a.unitId,
          storageLocationId: a.locationId,
          quantity: a.quantity,
          unitCostJpy: averageUnitCost(cost, a.quantity),
          costTotalJpy: cost,
          costStatus: a.status,
        },
      });
      await tx.stockMovement.create({
        data: {
          id: saleRecordId(input.idempotencyKey, `movement:${moveKey}`),
          operationId: operation.id,
          itemVariantId: variantId!,
          inventoryLotId: a.lotId,
          uniqueStockUnitId: a.unitId,
          movementType: "SALE_OUT",
          quantity: -a.quantity,
          costTotalJpy: -cost,
          movementAt: instant(input.date),
          businessUnitId: c.businessUnitId,
          storageLocationFromId: a.locationId,
          sourceType: "sales_order",
          sourceId: order.id,
          idempotencyKey: moveKey,
          operatorId: c.operatorId,
        },
      });
    }
    const balance = await tx.inventoryCostBalance.findUniqueOrThrow({
      where: {
        itemVariantId_businessUnitId_trackingMode: {
          itemVariantId: variantId!,
          businessUnitId: c.businessUnitId,
          trackingMode: mode,
        },
      },
    });
    const qty = balance.quantity - needed,
      cost = balance.carryingCostTotalJpy - componentCost;
    if (qty < 0 || cost < 0n) fail("在庫原価残高を確認してください。");
    await tx.inventoryCostBalance.update({
      where: { id: balance.id },
      data: {
        quantity: qty,
        carryingCostTotalJpy: cost,
        averageUnitCostJpy: qty ? averageUnitCost(cost, qty) : "0",
      },
    });
    total += componentCost;
  }
  await tx.salesOrderLine.update({
    where: { id: order.lines[0]!.id },
    data: { managementCogsJpy: total },
  });
  await tx.salesOrder.update({
    where: { id: order.id },
    data: { costStatus: final ? "FINAL" : "PROVISIONAL" },
  });
  await tx.salesOrderEvent.create({
    data: {
      id: saleRecordId(input.idempotencyKey, "event"),
      salesOrderId: order.id,
      toStatus: "COMPLETED",
      occurredAt: instant(input.date),
      operatorId: c.operatorId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  await finishDraft(tx, c, input, "COMMERCE_SALE", order.id);
  return {
    id: order.id,
    detail: { name: sku.name, quantity: input.quantity, cost: total.toString() },
  };
}

export async function recordMethod(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof methodSchema>,
) {
  return runWorkflow(db, c, input, "DELIVERY_METHOD", input.date, async (tx) => {
    const previous = input.id
      ? await tx.deliveryMethod.findFirst({ where: { id: input.id, workspaceId: c.workspaceId } })
      : null;
    if (input.id && (!previous || previous.revision !== input.revision)) conflict();
    const data = {
      name: input.name,
      defaultShippingJpy: yenOrNull(input.shipping),
      defaultAllocationMethod: input.allocationMethod,
    };
    const row = previous
      ? await tx.deliveryMethod.update({ where: { id: previous.id }, data })
      : await tx.deliveryMethod.create({ data: { workspaceId: c.workspaceId, ...data } });
    return { id: row.id, detail: { name: row.name } };
  });
}

export async function recordChannel(
  db: PrismaClient,
  c: WorkflowContext,
  input: z.infer<typeof channelSchema>,
) {
  return runWorkflow(db, c, input, "CHANNEL_SAVE", input.date, async (tx) => {
    const previous = input.id
      ? await tx.salesChannel.findFirst({ where: { id: input.id, workspaceId: c.workspaceId } })
      : null;
    if (input.id && (!previous || previous.revision !== input.revision)) conflict();
    if (
      input.deliveryMethodId &&
      !(await tx.deliveryMethod.findFirst({
        where: { id: input.deliveryMethodId, workspaceId: c.workspaceId, active: true },
      }))
    )
      fail("配送方法を確認してください。");
    if (
      input.receivingAccountId &&
      !(await tx.moneyAccount.findFirst({
        where: {
          id: input.receivingAccountId,
          accountKind: { not: "OWNER_CLEARING" },
          ...commerceScope(c),
          reportingEntityId: c.reportingEntityId,
          active: true,
        },
      }))
    )
      fail("受取口座を確認してください。");
    const data = {
      name: input.name,
      receivingAccountId: input.receivingAccountId || null,
      feeDeducted: input.feeDeducted ?? true,
      shippingDeducted: input.shippingDeducted ?? true,
      defaultFeeRate: input.feeRate === "" ? null : new Precise(input.feeRate).div(100).toFixed(6),
      defaultShippingJpy: yenOrNull(input.shipping),
      defaultDeliveryMethodId: input.deliveryMethodId || null,
    };
    const row = previous
      ? await tx.salesChannel.update({ where: { id: previous.id }, data })
      : await tx.salesChannel.create({
          data: { workspaceId: c.workspaceId, type: "OTHER", ...data },
        });
    return { id: row.id, detail: { name: row.name } };
  });
}

export async function recordSupplierConfig(db: PrismaClient, c: WorkflowContext, raw: unknown) {
  const input = supplierConfigSchema.parse(raw);
  return runWorkflow(db, c, input, "SUPPLIER_CONFIG", input.date, async (tx) => {
    const previous = input.id
      ? await tx.counterparty.findFirst({ where: { id: input.id, workspaceId: c.workspaceId } })
      : null;
    if (input.id && (!previous || previous.revision !== input.revision)) conflict();
    const duplicate = await tx.counterparty.findFirst({
      where: {
        workspaceId: c.workspaceId,
        type: "SUPPLIER",
        name: input.name,
        ...(input.id ? { id: { not: input.id } } : {}),
      },
    });
    if (duplicate) fail("同じ名前の取引先があります。");
    const data = {
      name: input.name,
      defaultCurrency: input.currency,
      defaultAllocationMethod: input.allocationMethod,
      memo: input.memo || null,
      active: input.active,
    };
    const r = previous
      ? await tx.counterparty.update({ where: { id: previous.id }, data })
      : await tx.counterparty.create({
          data: { workspaceId: c.workspaceId, type: "SUPPLIER", ...data },
        });
    return { id: r.id, detail: { name: r.name } };
  });
}
export async function executeCommerce(
  db: PrismaClient,
  c: WorkflowContext,
  kind: CommerceKind,
  payload: unknown,
) {
  switch (kind) {
    case "ITEM_SAVE":
    case "SUPPLY_SAVE":
      return recordCatalogEdit(db, c, kind, payload);
    case "BUY_CANCEL":
      return cancelPurchase(db, c, payload);
    case "SUPPLIER_CONFIG":
      return recordSupplierConfig(db, c, payload);
    case "OTHER_RECORD":
      return recordOther(db, c, payload);
    case "CATEGORY_SAVE":
      return recordCategory(db, c, payload);
    case "MATERIAL_USE":
      return recordMaterialUse(db, c, payload);
    case "ACCOUNT_SAVE":
      return recordAccount(db, c, payload);
    case "MONEY_RECORD":
      return recordMoney(db, c, payload);
    case "PURCHASE_RETURN":
      return recordPurchaseReturn(db, c, payload);
    case "DELIVERY":
      return recordDelivery(db, c, payload);
    case "PURCHASE_COST":
      return recordPurchaseCost(db, c, payload);
    case "PURCHASE_REFUND":
      return recordPurchaseCost(db, c, payload, true);
    case "DRAFT_REBASE":
      return rebaseCommerceDraft(db, c, payload);
    case "BUY":
      return recordBuy(db, c, buySchema.parse(payload));
    case "RECEIVE":
      return recordReceipt(db, c, receiveSchema.parse(payload));
    case "SALE":
      return recordSale(db, c, saleSchema.parse(payload));
    case "SKU_SAVE":
      return recordSku(db, c, skuSchema.parse(payload));
    case "SKU_BATCH":
      return recordSkuBatch(db, c, skuBatchSchema.parse(payload));
    case "DELIVERY_METHOD":
      return recordMethod(db, c, methodSchema.parse(payload));
    case "CHANNEL_SAVE":
      return recordChannel(db, c, channelSchema.parse(payload));
  }
}
