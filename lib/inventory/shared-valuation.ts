import Decimal from "decimal.js";
import type { Prisma } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { fingerprint, toJson } from "@/lib/sales/request-store";
import { effectiveCosts, type CostTarget } from "@/lib/inventory/effective-cost";
import {
  canonicalValuationResults,
  replayValuation,
  type ValuationRow,
} from "@/lib/inventory/valuation-engine";
import { averageUnitCost } from "@/lib/inventory/money";
import { managementProfit } from "@/lib/sales/money";
import { valuationSession } from "@/lib/inventory/valuation-session";
import { assertFixedStocktakes } from "@/lib/inventory/stocktake-ledger";
import { valuationBusinessInput } from "@/lib/inventory/valuation-input";
import { orderedReturnMovements } from "@/lib/sales/component-return-allocation";

type Tx = Prisma.TransactionClient;
const Precise = Decimal.clone({ precision: 80 });
const day = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
export type SharedValuationPreview = {
  receiptBalances?: {
    variantId: string;
    beforeQuantity: number;
    beforeCost: string;
    quantity: number;
    cost: string;
    provisional: boolean;
  }[];
  acquisitionImpacts?: { name: string; date: string; before: string; after: string }[];
  stocktake?: { bookQuantity: number; countedQuantity: number; difference: number };
  fingerprint: string;
  requiresOrder: boolean;
  choices: { id: string; label: string }[];
  changes: {
    type: CostTarget;
    id: string;
    before: string;
    after: string;
    date: string;
    orderId?: string;
  }[];
  balances: {
    variantId: string;
    trackingMode: "QUANTITY" | "UNIQUE";
    quantity: number;
    before: string;
    after: string;
  }[];
  orderImpacts: {
    name: string;
    date: string;
    beforeCost: string | null;
    afterCost: string | null;
    beforeProfit: string | null;
    afterProfit: string | null;
  }[];
  cost: string;
};
type Plan = SharedValuationPreview & { costs: Map<string, bigint>; order: string };
export class PreviewRollback extends Error {
  constructor(public plan: SharedValuationPreview) {
    super("Read-only preview rollback");
  }
}
export async function captureValuationPreview(run: () => Promise<unknown>) {
  try {
    await valuationSession.run({ preview: true }, run);
  } catch (error) {
    if (error instanceof PreviewRollback) {
      const {
        fingerprint,
        requiresOrder,
        choices,
        changes,
        balances,
        orderImpacts,
        cost,
        stocktake,
        acquisitionImpacts,
        receiptBalances,
      } = error.plan;
      return {
        fingerprint,
        requiresOrder,
        choices,
        changes,
        balances,
        orderImpacts,
        cost,
        stocktake,
        acquisitionImpacts,
        receiptBalances,
      };
    }
    throw error;
  }
  throw new Error("この操作には共通原価プレビューがありません。");
}
export const sharedValuationKinds = new Set([
  "BUY_CANCEL",
  "DELIVERY",
  "PURCHASE_COST",
  "PURCHASE_REFUND",
  "PURCHASE_RETURN",
  "BUY",
  "RECEIVE",
  "SALE",
  "LISTING_RETURN",
  "INVENTORY",
  "PURCHASE_RECEIVE",
  "PURCHASE_CANCEL",
  "RETURN",
  "DATE_CORRECT",
  "STOCKTAKE",
]);
export async function valuationCheckpoint(tx: Tx, c: WorkflowContext, input: object) {
  const [purchaseDocuments, inboundDeliveries] = await Promise.all([
    tx.purchaseDocument.findMany({
      where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      select: { id: true, revision: true },
      orderBy: { id: "asc" },
    }),
    tx.inboundDelivery.findMany({
      where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      select: { id: true, revision: true },
      orderBy: { id: "asc" },
    }),
  ]);
  const receiptCorrections = await tx.receiptCostCorrection.findMany({
    where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
    orderBy: { sequence: "asc" },
  });
  const [operations, dates, revision, runs, years, orders, purchases, balances] = await Promise.all(
    [
      tx.inventoryOperation.findMany({
        where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        orderBy: { id: "asc" },
      }),
      tx.eventDateCorrection.findMany({
        where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        orderBy: { id: "asc" },
      }),
      tx.inventoryRevision.findUnique({ where: { businessUnitId: c.businessUnitId } }),
      tx.valuationRun.findMany({
        where: { businessUnitId: c.businessUnitId },
        select: { id: true, sequence: true },
        orderBy: { sequence: "asc" },
      }),
      tx.businessUnitAssignment.findMany({
        where: { businessUnitId: c.businessUnitId },
        include: { fiscalYearProfile: true },
        orderBy: { id: "asc" },
      }),
      tx.salesOrder.findMany({
        where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        select: { id: true, revision: true },
        orderBy: { id: "asc" },
      }),
      tx.purchase.findMany({
        where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        select: { id: true, revision: true },
        orderBy: { id: "asc" },
      }),
      tx.inventoryCostBalance.findMany({
        where: { businessUnitId: c.businessUnitId },
        orderBy: { id: "asc" },
      }),
    ],
  );
  const payload = valuationBusinessInput(input as object);
  const previousDates = new Map(operations.map((o) => [o.id, day(o.occurredAt)]));
  for (const correction of [...dates].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  ))
    previousDates.set(correction.operationId, correction.effectiveDate.toISOString().slice(0, 10));
  return {
    receiptCorrectionIds: new Set(receiptCorrections.map((r) => r.id)),
    operationIds: new Set(operations.map((o) => o.id)),
    dateIds: new Set(dates.map((d) => d.id)),
    balances,
    previousDates,
    fingerprint: fingerprint({
      payload,
      context: c,
      operations,
      dates,
      revision,
      runs,
      years,
      orders,
      purchases,
      balances,
      receiptCorrections,
      purchaseDocuments,
      inboundDeliveries,
    }),
  };
}

/** Evaluate the exact executor under a savepoint. No business record from preview is committed. */
export async function evaluateMutation(
  tx: Tx,
  c: WorkflowContext,
  input: { idempotencyKey: string; valuationPosition?: string },
  checkpoint: Awaited<ReturnType<typeof valuationCheckpoint>>,
  run: () => Promise<unknown>,
): Promise<Plan> {
  await tx.$executeRawUnsafe("SAVEPOINT valuation_preview");
  try {
    await valuationSession.run({ evaluating: true, requestKey: input.idempotencyKey }, run);
    const [newOperations, corrections, stocktakes] = await Promise.all([
      tx.inventoryOperation.findMany({
        where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        include: { movements: true },
      }),
      tx.eventDateCorrection.findMany({
        where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      tx.stocktakeObservation.findMany({
        where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      }),
    ]);
    const changed = new Set(
      newOperations.filter((o) => !checkpoint.operationIds.has(o.id)).map((o) => o.id),
    );
    const repositioned = new Set(changed);
    const receiptOperations = new Set(
      newOperations
        .filter(
          (op) =>
            changed.has(op.id) &&
            op.movements.some((m) => m.movementType === "RECEIPT" && !m.uniqueStockUnitId),
        )
        .map((op) => op.id),
    );
    const acquisitionChanges = await tx.receiptCostCorrection.findMany({
      where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      include: { movement: true },
      orderBy: { sequence: "asc" },
    });
    const newAcquisitionChanges = acquisitionChanges.filter(
      (r) => !checkpoint.receiptCorrectionIds.has(r.id),
    );
    for (const change of newAcquisitionChanges) changed.add(change.operationId);
    for (const correction of corrections)
      if (!checkpoint.dateIds.has(correction.id)) {
        changed.add(correction.operationId);
        repositioned.add(correction.operationId);
      }
    const affected = newOperations.filter((o) => changed.has(o.id));
    const variantIds = [
      ...new Set([
        ...affected.flatMap((o) => o.movements.map((m) => m.itemVariantId)),
        ...stocktakes.filter((s) => changed.has(s.operationId)).map((s) => s.itemVariantId),
      ]),
    ];
    if (!affected.length) {
      return {
        fingerprint: checkpoint.fingerprint,
        cost: "0",
        requiresOrder: false,
        choices: [],
        changes: [],
        balances: [],
        orderImpacts: [],
        costs: new Map(),
        order: "0",
      };
    }
    const operationDates = new Map(newOperations.map((o) => [o.id, day(o.occurredAt)]));
    const operationOrders = new Map(newOperations.map((o) => [o.id, o.valuationOrder.toString()]));
    for (const correction of corrections) {
      operationDates.set(
        correction.operationId,
        correction.effectiveDate.toISOString().slice(0, 10),
      );
      if (correction.valuationOrder !== null)
        operationOrders.set(correction.operationId, correction.valuationOrder.toString());
    }
    const date = operationDates.get(affected[0]!.id)!;
    const startDate = [
      ...affected.map((o) => day(o.occurredAt)),
      ...affected.map((o) => operationDates.get(o.id)!),
      ...affected.flatMap((o) =>
        checkpoint.previousDates.has(o.id) ? [checkpoint.previousDates.get(o.id)!] : [],
      ),
    ].sort()[0]!;
    const observations = stocktakes.filter((s) => variantIds.includes(s.itemVariantId));
    if (observations.some((s) => s.reportingEntityId !== c.reportingEntityId))
      throw new WorkflowError("OWNERSHIP_CHANGED", "別の申告主体の実測記録に影響します。");
    const operations = newOperations.filter(
      (o) =>
        o.movements.some((m) => variantIds.includes(m.itemVariantId)) ||
        observations.some((s) => s.operationId === o.id),
    );
    const sameDay = operations
      .filter((o) => !changed.has(o.id) && operationDates.get(o.id) === date)
      .sort(
        (a, b) =>
          new Precise(operationOrders.get(a.id)!).comparedTo(operationOrders.get(b.id)!) ||
          a.id.localeCompare(b.id),
      );
    const choices = [
      ...sameDay.map((o) => ({
        id: o.id,
        label: `${({ PURCHASE_RECEIPT: "入庫", SALE_COMPLETION: "取引完了", SALE_RETURN: "返品", LOCATION_TRANSFER: "場所移動" } as Record<string, string>)[o.operationType] ?? "在庫操作"}（${operationDates.get(o.id)}・記録順 ${o.valuationOrder.toFixed(0)}）より前`,
      })),
      { id: "LAST", label: "同日の記録の後" },
    ];
    if (input.valuationPosition && !choices.some((x) => x.id === input.valuationPosition))
      throw new WorkflowError(
        "CONFLICT",
        "同日の取引が変更されました。計算順序を選び直してください。",
      );
    const [consumptions, dispositions, balances, assignments, items, units] = await Promise.all([
      tx.orderComponentConsumption.findMany({
        where: {
          itemVariantId: { in: variantIds },
          salesOrderLine: {
            salesOrder: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
          },
        },
        include: { salesOrderLine: { include: { salesOrder: true } } },
        orderBy: { id: "asc" },
      }),
      tx.returnComponentDisposition.findMany({
        where: {
          itemVariantId: { in: variantIds },
          salesReturnLine: {
            salesReturn: {
              salesOrder: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
            },
          },
        },
        include: { salesReturnLine: { include: { salesReturn: true } } },
        orderBy: { id: "asc" },
      }),
      tx.inventoryCostBalance.findMany({
        where: { businessUnitId: c.businessUnitId, itemVariantId: { in: variantIds } },
      }),
      tx.businessUnitAssignment.findMany({
        where: { businessUnitId: c.businessUnitId },
        include: { fiscalYearProfile: true },
      }),
      tx.itemVariant.findMany({
        where: { id: { in: variantIds }, workspaceId: c.workspaceId },
        include: {
          inventoryItem: true,
          inventoryLots: {
            include: {
              purchaseLine: { include: { purchase: true } },
              documentReceiptLine: { include: { receipt: true } },
            },
          },
        },
      }),
      tx.uniqueStockUnit.findMany({
        where: { workspaceId: c.workspaceId, itemVariantId: { in: variantIds } },
      }),
    ]);
    if (
      items.length !== variantIds.length ||
      items.some((v) => v.inventoryItem.businessUnitId !== c.businessUnitId)
    )
      throw new WorkflowError("CONTEXT_CHANGED", "構成商品の部門を確認できません。");
    if (
      consumptions.some(
        (r) => r.salesOrderLine.salesOrder.reportingEntityId !== c.reportingEntityId,
      ) ||
      items.some((v) =>
        v.inventoryLots.some(
          (l) =>
            (l.purchaseLine && l.purchaseLine.purchase.reportingEntityId !== c.reportingEntityId) ||
            (l.documentReceiptLine &&
              l.documentReceiptLine.receipt.reportingEntityId !== c.reportingEntityId),
        ),
      )
    )
      throw new WorkflowError("OWNERSHIP_CHANGED", "別の申告主体の在庫・取引が含まれます。");
    const movements = operations
      .flatMap((o) => o.movements)
      .filter((m) => variantIds.includes(m.itemVariantId));
    const [mc, cc, dc] = await Promise.all([
      effectiveCosts(tx, "MOVEMENT", movements),
      effectiveCosts(tx, "CONSUMPTION", consumptions),
      effectiveCosts(tx, "DISPOSITION", dispositions),
    ]);
    const rows = new Map<string, ValuationRow>();
    const usedC = new Set<string>(),
      usedD = new Set<string>();
    for (const m of movements) {
      const row: ValuationRow = {
        id: m.id,
        kind: m.movementType,
        quantity: m.quantity,
        cost: mc.get(m.id)!,
      };
      if (
        m.uniqueStockUnitId &&
        newAcquisitionChanges.some((r) => r.movement.uniqueStockUnitId === m.uniqueStockUnitId) &&
        m.movementType !== "LOCATION_TRANSFER"
      ) {
        const unit = units.find((u) => u.id === m.uniqueStockUnitId);
        if (!unit) throw new WorkflowError("HISTORY_INCOMPLETE", "個体の原価を確認できません。");
        row.cost = BigInt(m.quantity) * unit.acquisitionCostJpy;
      }
      if (m.movementType === "SALE_OUT") {
        const original = consumptions.find(
          (r) =>
            !usedC.has(r.id) &&
            r.salesOrderLine.salesOrderId === m.sourceId &&
            r.itemVariantId === m.itemVariantId &&
            r.uniqueStockUnitId === m.uniqueStockUnitId &&
            (r.uniqueStockUnitId || r.inventoryLotId === m.inventoryLotId) &&
            r.storageLocationId === m.storageLocationFromId &&
            r.quantity === -m.quantity &&
            r.costTotalJpy === -m.costTotalJpy,
        );
        if (!original)
          throw new WorkflowError("HISTORY_INCOMPLETE", "販売出庫と構成品消費を照合できません。");
        row.consumptionId = original.id;
        usedC.add(original.id);
      }
      if (["RETURN_IN", "RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(m.movementType)) {
        if (m.sourceType === "listing") {
          const out = movements.find(
            (v) =>
              v.operationId === m.operationId &&
              v.itemVariantId === m.itemVariantId &&
              v.inventoryLotId === m.inventoryLotId &&
              v.uniqueStockUnitId === m.uniqueStockUnitId &&
              v.quantity === -m.quantity &&
              v.idempotencyKey === m.idempotencyKey.replace(/:disposition$/, ":out"),
          );
          if (!out)
            throw new WorkflowError("HISTORY_INCOMPLETE", "返送処理の原価を照合できません。");
          row.mirrorOutId = out.id;
        } else {
          const original = dispositions.find(
            (r) =>
              !usedD.has(r.id) &&
              r.salesReturnLine.salesReturnId === m.sourceId &&
              r.itemVariantId === m.itemVariantId &&
              r.uniqueStockUnitId === m.uniqueStockUnitId &&
              (r.uniqueStockUnitId || r.inventoryLotId === m.inventoryLotId) &&
              r.quantity === m.quantity &&
              r.costTotalJpy === m.costTotalJpy &&
              r.storageLocationId === m.storageLocationToId &&
              r.disposition ===
                (
                  {
                    RETURN_IN: "RESTOCK",
                    RETURN_DEFECTIVE: "DEFECTIVE",
                    RETURN_DISPOSAL: "DISPOSED",
                  } as Record<string, string>
                )[m.movementType],
          );
          const source = consumptions.find((v) => v.id === original?.consumptionId);
          if (!original || !source)
            throw new WorkflowError("HISTORY_INCOMPLETE", "返品と元の消費を照合できません。");
          row.returnId = original.id;
          row.returnConsumptionId = source.id;
          row.returnConsumptionQuantity = source.quantity;
          usedD.add(original.id);
        }
      }
      rows.set(m.id, row);
    }
    const orderFor = (selected: string) => {
      const index = sameDay.findIndex((o) => o.id === selected);
      return index < 0
        ? new Precise(sameDay.length ? operationOrders.get(sameDay.at(-1)!.id)! : "0").plus(1)
        : new Precise(operationOrders.get(sameDay[index]!.id)!)
            .plus(
              index
                ? operationOrders.get(sameDay[index - 1]!.id)!
                : new Precise(operationOrders.get(sameDay[index]!.id)!).minus(2),
            )
            .div(2);
    };
    const calculate = (position: string) => {
      const order = new Precise(orderFor(position).toFixed(30));
      const beforeIndex = sameDay.findIndex((o) => o.id === position);
      if (
        (beforeIndex >= 0 &&
          order.greaterThanOrEqualTo(operationOrders.get(sameDay[beforeIndex]!.id)!)) ||
        (beforeIndex > 0 &&
          order.lessThanOrEqualTo(operationOrders.get(sameDay[beforeIndex - 1]!.id)!)) ||
        (beforeIndex < 0 &&
          sameDay.length &&
          order.lessThanOrEqualTo(operationOrders.get(sameDay.at(-1)!.id)!))
      )
        throw new WorkflowError(
          "HISTORY_INCOMPLETE",
          "同日の計算順序を安全に追加できません。履歴の確認が必要です。",
        );
      const ordered = [...operations].sort(
        (a, b) =>
          operationDates.get(a.id)!.localeCompare(operationDates.get(b.id)!) ||
          new Precise(repositioned.has(a.id) ? order : operationOrders.get(a.id)!).comparedTo(
            repositioned.has(b.id) ? order : operationOrders.get(b.id)!,
          ) ||
          a.id.localeCompare(b.id),
      );
      const results = new Map<string, ReturnType<typeof replayValuation>>();
      assertFixedStocktakes(
        ordered.map((op) => ({
          id: op.id,
          date: operationDates.get(op.id)!,
          order: repositioned.has(op.id) ? order.toFixed(30) : operationOrders.get(op.id)!,
          movements: op.movements,
        })),
        observations,
      );
      const quantities = new Map<string, number>();
      const receiptProvisional = new Map<string, boolean>();
      const locationQuantities = new Map<string, number>();
      const locationDelta = (key: string, q: number) => {
        const next = (locationQuantities.get(key) ?? 0) + q;
        if (next < 0)
          throw new WorkflowError(
            "HISTORY_INCOMPLETE",
            "過去のロット・個体・保管場所で数量が不足します。元の移動を付け替えず入力を保持します。",
          );
        locationQuantities.set(key, next);
      };
      for (const op of ordered) {
        for (const m of op.movements.filter((r) => variantIds.includes(r.itemVariantId))) {
          if (["RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(m.movementType)) continue;
          const key = m.uniqueStockUnitId ?? m.inventoryLotId;
          if (!key) throw new WorkflowError("HISTORY_INCOMPLETE", "在庫履歴の追跡先がありません。");
          if (m.movementType === "LOCATION_TRANSFER") {
            locationDelta(`${key}:${m.storageLocationFromId}`, -m.quantity);
            locationDelta(`${key}:${m.storageLocationToId}`, m.quantity);
          } else {
            locationDelta(
              `${key}:${m.quantity < 0 ? m.storageLocationFromId : m.storageLocationToId}`,
              m.quantity,
            );
            const next = (quantities.get(key) ?? 0) + m.quantity;
            if (next < 0 || (m.uniqueStockUnitId && next > 1))
              throw new WorkflowError(
                "HISTORY_INCOMPLETE",
                "過去のロット・個体の残数が成立しません。",
              );
            quantities.set(key, next);
          }
        }
        if (receiptOperations.has(op.id))
          for (const item of items)
            receiptProvisional.set(
              `${op.id}:${item.id}`,
              item.inventoryLots.some(
                (lot) =>
                  lot.trackingMode === "QUANTITY" &&
                  (quantities.get(lot.id) ?? 0) > 0 &&
                  lot.costStatus !== "FINAL",
              ),
            );
      }
      for (const id of variantIds) {
        for (const mode of ["QUANTITY", "UNIQUE"] as const) {
          const unique = mode === "UNIQUE";
          const vm = movements.filter(
            (m) => m.itemVariantId === id && !!m.uniqueStockUnitId === unique,
          );
          if (!vm.length) continue;
          const events = ordered
            .map((op) => ({
              id: op.id,
              preserveCosts: unique || operationDates.get(op.id)! < startDate,
              rows: orderedReturnMovements(
                op.movements.filter(
                  (m) => m.itemVariantId === id && !!m.uniqueStockUnitId === unique,
                ),
              )
                .map((m) => rows.get(m.id)!)
                .sort((a, b) => Number(!!a.mirrorOutId) - Number(!!b.mirrorOutId)),
            }))
            .filter((e) => e.rows.length);
          results.set(
            `${id}:${mode}`,
            replayValuation(events, mode === "QUANTITY" ? receiptOperations : undefined),
          );
        }
      }
      return {
        results,
        quantities,
        locationQuantities,
        receiptProvisional,
        order: order.toFixed(30),
      };
    };
    let selected: ReturnType<typeof calculate>;
    try {
      selected = calculate(input.valuationPosition ?? "LAST");
    } catch (error) {
      if (input.valuationPosition) throw error;
      const valid = sameDay.flatMap((candidate) => {
        try {
          return [calculate(candidate.id)];
        } catch {
          return [];
        }
      });
      if (!valid.length) throw error;
      selected = valid[0]!;
    }
    let requiresOrder = false;
    if (!input.valuationPosition && sameDay.length) {
      const signature = (r: ReturnType<typeof calculate>) =>
        fingerprint(canonicalValuationResults(r.results));
      const last = signature(selected);
      try {
        calculate("LAST");
      } catch {
        requiresOrder = true;
      }
      for (const candidate of sameDay) {
        try {
          if (signature(calculate(candidate.id)) !== last) {
            requiresOrder = true;
            break;
          }
        } catch {
          requiresOrder = true;
          break;
        }
      }
    }
    const changes: SharedValuationPreview["changes"] = [];
    const costs = new Map<string, bigint>();
    const projectedBalances: SharedValuationPreview["balances"] = [];
    const lockedYears = new Set(
      assignments
        .filter((a) => a.fiscalYearProfile.status === "LOCKED")
        .map((a) => a.fiscalYearProfile.year),
    );
    for (const [group, result] of selected.results) {
      const [id, mode] = group.split(":") as [string, "QUANTITY" | "UNIQUE"];
      const vm = movements.filter(
        (m) => m.itemVariantId === id && !!m.uniqueStockUnitId === (mode === "UNIQUE"),
      );
      const balance = balances.find((b) => b.itemVariantId === id && b.trackingMode === mode);
      const ledger = vm.filter(
        (m) =>
          !["LOCATION_TRANSFER", "RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(m.movementType),
      );
      const rawQuantity = ledger.reduce((s, m) => s + m.quantity, 0),
        rawCost = ledger.reduce((s, m) => s + mc.get(m.id)!, 0n);
      const acquisitionDelta = newAcquisitionChanges
        .filter(
          (r) =>
            r.movement.itemVariantId === id &&
            !!r.movement.uniqueStockUnitId === (mode === "UNIQUE"),
        )
        .reduce((s, r) => s + r.afterJpy - r.beforeJpy, 0n);
      if (
        !balance ||
        balance.quantity !== rawQuantity ||
        balance.carryingCostTotalJpy + acquisitionDelta !== rawCost
      )
        throw new WorkflowError("HISTORY_INCOMPLETE", "履歴と現在の在庫・原価残高が一致しません。");
      const item = items.find((v) => v.id === id)!;
      if (
        item.inventoryLots.some(
          (lot) =>
            lot.trackingMode === "QUANTITY" &&
            (selected.quantities.get(lot.id) ?? 0) !== lot.remainingQuantity,
        ) &&
        mode === "QUANTITY"
      )
        throw new WorkflowError("HISTORY_INCOMPLETE", "ロット履歴と現在残数が一致しません。");
      if (
        mode === "UNIQUE" &&
        units
          .filter((u) => u.itemVariantId === id)
          .some(
            (u) =>
              (selected.quantities.get(u.id) ?? 0) !==
              (["IN_STOCK", "RESERVED"].includes(u.status) ? 1 : 0),
          )
      )
        throw new WorkflowError("HISTORY_INCOMPLETE", "個体の履歴と現在状態が一致しません。");
      projectedBalances.push({
        variantId: id,
        trackingMode: mode,
        quantity: result.quantity,
        before: (
          checkpoint.balances.find((b) => b.itemVariantId === id && b.trackingMode === mode)
            ?.carryingCostTotalJpy ?? 0n
        ).toString(),
        after: result.cost.toString(),
      });
      const addChange = (
        type: CostTarget,
        targetId: string,
        before: bigint,
        after: bigint,
        at: string,
        orderId?: string,
      ) => {
        if (before === after) return;
        if (lockedYears.has(Number(at.slice(0, 4))))
          throw new WorkflowError(
            "YEAR_LOCKED",
            "ロック済み年度の原価に影響するため確定できません。",
          );
        changes.push({
          type,
          id: targetId,
          before: before.toString(),
          after: after.toString(),
          date: at,
          orderId,
        });
      };
      for (const m of vm) {
        const amount = result.movementCosts.get(m.id)!;
        if (!checkpoint.operationIds.has(m.operationId))
          costs.set(m.idempotencyKey.replace(input.idempotencyKey, "pending"), amount);
        else addChange("MOVEMENT", m.id, mc.get(m.id)!, amount, operationDates.get(m.operationId)!);
      }
      for (const consumption of consumptions.filter((r) => r.itemVariantId === id)) {
        const amount = result.consumptionCosts.get(consumption.id);
        const sourceOperation = movements.find(
          (m) => rows.get(m.id)?.consumptionId === consumption.id,
        )?.operationId;
        if (amount !== undefined && sourceOperation && checkpoint.operationIds.has(sourceOperation))
          addChange(
            "CONSUMPTION",
            consumption.id,
            cc.get(consumption.id)!,
            amount,
            operationDates.get(
              movements.find((m) => rows.get(m.id)?.consumptionId === consumption.id)!.operationId,
            )!,
            consumption.salesOrderLine.salesOrderId,
          );
      }
      for (const disposition of dispositions.filter((r) => r.itemVariantId === id)) {
        const amount = result.dispositionCosts.get(disposition.id);
        if (
          amount !== undefined &&
          checkpoint.operationIds.has(
            movements.find((m) => rows.get(m.id)?.returnId === disposition.id)!.operationId,
          )
        )
          addChange(
            "DISPOSITION",
            disposition.id,
            dc.get(disposition.id)!,
            amount,
            operationDates.get(
              movements.find((m) => rows.get(m.id)?.returnId === disposition.id)!.operationId,
            )!,
            disposition.salesReturnLine.salesReturn.salesOrderId,
          );
      }
    }
    const orderIds = [...new Set(changes.flatMap((x) => (x.orderId ? [x.orderId] : [])))];
    const affectedOrders = await tx.salesOrder.findMany({
      where: { id: { in: orderIds }, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      include: {
        lines: { include: { consumptions: true, salesSku: true } },
        returns: { include: { lines: { include: { dispositions: true } } } },
      },
    });
    const impacts: SharedValuationPreview["orderImpacts"] = [];
    for (const order of affectedOrders) {
      const before = order.lines.some((l) => l.managementCogsJpy === null)
        ? null
        : order.lines.reduce((s, l) => s + l.managementCogsJpy!, 0n);
      const after =
        before === null
          ? null
          : before +
            changes
              .filter((r) => r.type === "CONSUMPTION" && r.orderId === order.id)
              .reduce((s, r) => s + BigInt(r.after) - BigInt(r.before), 0n);
      const profit = (cost: bigint | null, corrected: boolean) => {
        if (
          cost === null ||
          order.costStatus !== "FINAL" ||
          [order.feeJpy, order.shippingJpy, order.packingJpy, order.otherCostJpy].some(
            (v) => v === null,
          )
        )
          return null;
        let restored = 0n;
        for (const d of order.returns
          .flatMap((r) => r.lines.flatMap((l) => l.dispositions))
          .filter((d) => d.disposition === "RESTOCK"))
          restored += corrected
            ? BigInt(
                changes.find((r) => r.type === "DISPOSITION" && r.id === d.id)?.after ??
                  dc.get(d.id) ??
                  d.costTotalJpy,
              )
            : (dc.get(d.id) ?? d.costTotalJpy);
        return managementProfit({
          gross: order.grossSalesJpy,
          discount: order.discountJpy,
          fee: order.feeJpy!,
          shipping: order.shippingJpy!,
          packing: order.packingJpy!,
          other: order.otherCostJpy!,
          cogs: cost,
          salesRefund: order.returns.reduce((s, r) => s + r.salesRefundJpy, 0n),
          feeRefund: order.returns.reduce((s, r) => s + r.feeRefundJpy, 0n),
          shippingRefund: order.returns.reduce((s, r) => s + r.shippingRefundJpy, 0n),
          restockedCost: restored,
        }).toString();
      };
      impacts.push({
        name: order.lines.map((l) => l.salesSku.name).join("・"),
        date: day(order.completedAt!),
        beforeCost: before?.toString() ?? null,
        afterCost: after?.toString() ?? null,
        beforeProfit: profit(before, false),
        afterProfit: profit(after, true),
      });
    }
    return {
      fingerprint: checkpoint.fingerprint,
      stocktake: stocktakes.find((s) => changed.has(s.operationId))
        ? (({ bookQuantity, countedQuantity, difference }) => ({
            bookQuantity,
            countedQuantity,
            difference,
          }))(stocktakes.find((s) => changed.has(s.operationId))!)
        : undefined,
      requiresOrder,
      choices,
      changes,
      balances: projectedBalances,
      receiptBalances: [...selected.results].flatMap(([group, result]) =>
        [...(result.eventBalances ?? [])].map(([operationId, balance]) => ({
          variantId: group.split(":")[0]!,
          beforeQuantity: balance.beforeQuantity,
          beforeCost: balance.beforeCost.toString(),
          quantity: balance.quantity,
          cost: balance.cost.toString(),
          provisional:
            selected.receiptProvisional.get(`${operationId}:${group.split(":")[0]}`) ?? false,
        })),
      ),
      acquisitionImpacts: newAcquisitionChanges.map((change) => ({
        name:
          items.find((v) => v.id === change.movement.itemVariantId)?.inventoryItem.name || "商品",
        date: operationDates.get(change.operationId)!,
        before: change.beforeJpy.toString(),
        after: change.afterJpy.toString(),
      })),
      orderImpacts: impacts,
      cost: [...costs.values()]
        .filter((v) => v < 0n)
        .reduce((s, v) => s - v, 0n)
        .toString(),
      costs,
      order: selected.order,
    };
  } finally {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT valuation_preview");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT valuation_preview");
  }
}

export async function applyMutationValuation(
  tx: Tx,
  c: WorkflowContext,
  key: string,
  kind: string,
  targetId: string,
  plan: Plan,
) {
  const run = await tx.valuationRun.create({
    data: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      operatorId: c.operatorId,
      requestId: key,
      sourceType: kind,
      sourceId: targetId,
      summary: toJson({ ...plan, costs: undefined }),
    },
  });
  if (plan.changes.length)
    await tx.valuationAdjustment.createMany({
      data: plan.changes.map((v) => ({
        runId: run.id,
        targetType: v.type,
        targetId: v.id,
        beforeJpy: BigInt(v.before),
        afterJpy: BigInt(v.after),
        deltaJpy: BigInt(v.after) - BigInt(v.before),
      })),
    });
  for (const b of plan.balances) {
    const existing = await tx.inventoryCostBalance.findFirstOrThrow({
      where: {
        businessUnitId: c.businessUnitId,
        itemVariantId: b.variantId,
        trackingMode: b.trackingMode,
      },
    });
    await tx.inventoryCostBalance.update({
      where: { id: existing.id },
      data: {
        quantity: b.quantity,
        carryingCostTotalJpy: BigInt(b.after),
        averageUnitCostJpy: b.quantity ? averageUnitCost(BigInt(b.after), b.quantity) : "0",
      },
    });
  }
  const orderIds = [...new Set(plan.changes.flatMap((v) => (v.orderId ? [v.orderId] : [])))];
  for (const id of orderIds) {
    const lines = await tx.salesOrderLine.findMany({
      where: { salesOrderId: id },
      include: { consumptions: true },
    });
    for (const line of lines) {
      const costs = await effectiveCosts(tx, "CONSUMPTION", line.consumptions);
      await tx.salesOrderLine.update({
        where: { id: line.id },
        data: { managementCogsJpy: [...costs.values()].reduce((s, v) => s + v, 0n) },
      });
    }
    await tx.salesOrder.update({ where: { id }, data: { revision: { increment: 1 } } });
  }
}
