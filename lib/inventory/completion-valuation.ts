import Decimal from "decimal.js";
import type { Prisma } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow";
import { fingerprint, toJson } from "@/lib/sales/request-store";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import { effectiveCosts, type CostTarget } from "@/lib/inventory/effective-cost";
import {
  replayValuation,
  type ValuationEvent,
  type ValuationRow,
} from "@/lib/inventory/valuation-engine";
import { averageUnitCost } from "@/lib/inventory/money";
import { confirmedProfit } from "@/lib/validation/workflow";
import { effectiveLotReceiptDates, effectiveOperationTimeline } from "@/lib/inventory/event-dates";
import { assertFixedStocktakes } from "@/lib/inventory/stocktake-ledger";
import { orderedReturnMovements } from "@/lib/sales/component-return-allocation";

type Tx = Prisma.TransactionClient;
const Precise = Decimal.clone({ precision: 80 });
const day = (v: Date) => v.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
export type ValuationChange = {
  type: CostTarget;
  id: string;
  before: bigint;
  after: bigint;
  date: string;
  orderId?: string;
};
export type CompletionValuation = {
  fingerprint: string;
  order: string;
  cost: bigint;
  final: boolean;
  pendingCosts: Map<string, bigint>;
  balances: Map<string, { quantity: number; before: bigint; after: bigint }>;
  changes: ValuationChange[];
  choices: { id: string; label: string }[];
  requiresOrder: boolean;
  orderImpacts: {
    id: string;
    name: string;
    date: string;
    beforeCost: bigint | null;
    afterCost: bigint | null;
    beforeProfit: bigint | null;
    afterProfit: bigint | null;
  }[];
};

export async function buildCompletionValuation(
  tx: Tx,
  c: WorkflowContext,
  listingId: string,
  date: string,
  position?: string,
): Promise<CompletionValuation> {
  const rows = await tx.inventoryReservation.findMany({
    where: {
      listingId,
      status: "RESERVED",
      itemVariant: {
        inventoryItem: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
      },
    },
    include: {
      inventoryLot: { include: { purchaseLine: { include: { purchase: true } } } },
      uniqueStockUnit: {
        include: { inventoryLot: { include: { purchaseLine: { include: { purchase: true } } } } },
      },
    },
    orderBy: { id: "asc" },
  });
  if (!rows.length)
    throw new WorkflowError(
      "STOCK_SHORTAGE",
      "確保在庫がありません。出品の構成を確認してください。",
    );
  const receiptDates = await effectiveLotReceiptDates(tx, [
    ...new Set(
      rows.flatMap((r) => {
        const lot = r.inventoryLot ?? r.uniqueStockUnit?.inventoryLot;
        return lot ? [lot.id] : [];
      }),
    ),
  ]);
  for (const r of rows) {
    const lot = r.inventoryLot ?? r.uniqueStockUnit?.inventoryLot;
    if (lot?.purchaseLine && lot.purchaseLine.purchase.reportingEntityId !== c.reportingEntityId)
      throw new WorkflowError(
        "OWNERSHIP_CHANGED",
        "確保した商品の仕入時の申告主体が異なります。在庫移管の確認が必要です。",
      );
    if (!lot || !receiptDates.has(lot.id) || receiptDates.get(lot.id)! > date)
      throw new WorkflowError(
        "HISTORY_INCOMPLETE",
        "確保した商品は指定した完了日にまだ入庫していません。入庫日・完了日を確認してください。",
      );
  }
  const ids = [...new Set(rows.filter((r) => !r.uniqueStockUnitId).map((r) => r.itemVariantId))];
  for (const id of new Set(rows.filter((r) => r.uniqueStockUnitId).map((r) => r.itemVariantId))) {
    const [units, balance] = await Promise.all([
      tx.uniqueStockUnit.findMany({
        where: {
          itemVariantId: id,
          workspaceId: c.workspaceId,
          status: { in: ["IN_STOCK", "RESERVED"] },
        },
        select: { acquisitionCostJpy: true },
      }),
      tx.inventoryCostBalance.findUnique({
        where: {
          itemVariantId_businessUnitId_trackingMode: {
            itemVariantId: id,
            businessUnitId: c.businessUnitId,
            trackingMode: "UNIQUE",
          },
        },
      }),
    ]);
    if (
      !balance ||
      balance.quantity !== units.length ||
      balance.carryingCostTotalJpy !== units.reduce((s, u) => s + u.acquisitionCostJpy, 0n)
    )
      throw new WorkflowError(
        "HISTORY_INCOMPLETE",
        "個体一覧と管理在庫・原価残高が一致しません。元の入庫・返品を確認してください。",
      );
  }
  const [movements, consumptions, dispositions, balances, revision, fiscals, uniqueMovements] =
    await Promise.all([
      tx.stockMovement.findMany({
        where: {
          businessUnitId: c.businessUnitId,
          itemVariantId: { in: ids },
          uniqueStockUnitId: null,
        },
        include: {
          operation: true,
          inventoryLot: { include: { purchaseLine: { include: { purchase: true } } } },
        },
        orderBy: { id: "asc" },
      }),
      tx.orderComponentConsumption.findMany({
        where: {
          itemVariantId: { in: ids },
          uniqueStockUnitId: null,
          salesOrderLine: {
            salesOrder: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
          },
        },
        include: { salesOrderLine: { include: { salesOrder: true } } },
        orderBy: { id: "asc" },
      }),
      tx.returnComponentDisposition.findMany({
        where: {
          itemVariantId: { in: ids },
          uniqueStockUnitId: null,
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
        where: {
          businessUnitId: c.businessUnitId,
          itemVariantId: { in: ids },
          trackingMode: "QUANTITY",
        },
      }),
      tx.inventoryRevision.findUnique({ where: { businessUnitId: c.businessUnitId } }),
      tx.businessUnitAssignment.findMany({
        where: { businessUnitId: c.businessUnitId },
        include: { fiscalYearProfile: true },
      }),
      tx.stockMovement.findMany({
        where: {
          businessUnitId: c.businessUnitId,
          uniqueStockUnitId: {
            in: rows.flatMap((r) => (r.uniqueStockUnitId ? [r.uniqueStockUnitId] : [])),
          },
        },
        include: { operation: true },
        orderBy: { id: "asc" },
      }),
    ]);
  const [mc, cc, dc] = await Promise.all([
    effectiveCosts(tx, "MOVEMENT", movements),
    effectiveCosts(tx, "CONSUMPTION", consumptions),
    effectiveCosts(tx, "DISPOSITION", dispositions),
  ]);
  const uniqueSaleIds = [
    ...new Set(uniqueMovements.filter((m) => m.movementType === "SALE_OUT").map((m) => m.sourceId)),
  ];
  const uniqueSales = await tx.salesOrder.findMany({
    where: {
      id: { in: uniqueSaleIds },
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
    },
    select: { id: true, reportingEntityId: true },
  });
  if (uniqueSales.length !== uniqueSaleIds.length)
    throw new WorkflowError(
      "HISTORY_INCOMPLETE",
      "個体の販売出庫に対応する取引履歴を確認できません。",
    );
  if (uniqueSales.some((o) => o.reportingEntityId !== c.reportingEntityId))
    throw new WorkflowError(
      "OWNERSHIP_CHANGED",
      "個体の過去取引に別の申告主体が含まれます。在庫移管の確認が必要です。",
    );
  const lotTotals = await tx.inventoryLot.groupBy({
    by: ["itemVariantId"],
    where: { itemVariantId: { in: ids }, trackingMode: "QUANTITY" },
    _sum: { remainingQuantity: true },
  });
  const sourceRows = new Map<string, ValuationRow>();
  const usedConsumption = new Set<string>(),
    usedDisposition = new Set<string>();
  for (const m of movements) {
    const row: ValuationRow = {
      id: m.id,
      kind: m.movementType,
      quantity: m.quantity,
      cost: mc.get(m.id)!,
    };
    if (
      m.inventoryLot?.purchaseLine &&
      m.inventoryLot.purchaseLine.purchase.reportingEntityId !== c.reportingEntityId
    )
      throw new WorkflowError(
        "OWNERSHIP_CHANGED",
        "別の申告主体の仕入れが含まれます。在庫移管の確認が必要です。",
      );
    if (m.movementType === "SALE_OUT") {
      const matches = consumptions.filter(
        (x) =>
          !usedConsumption.has(x.id) &&
          x.salesOrderLine.salesOrderId === m.sourceId &&
          x.itemVariantId === m.itemVariantId &&
          x.inventoryLotId === m.inventoryLotId &&
          x.storageLocationId === m.storageLocationFromId &&
          x.quantity === -m.quantity &&
          x.costTotalJpy === -m.costTotalJpy,
      );
      if (!matches.length || new Set(matches.map((x) => x.salesOrderLineId)).size > 1)
        throw new WorkflowError(
          "HISTORY_INCOMPLETE",
          "販売出庫と構成品原価の対応を一意に確認できません。旧記録の確認が必要です。",
        );
      const match = matches[0]!;
      if (match.salesOrderLine.salesOrder.reportingEntityId !== c.reportingEntityId)
        throw new WorkflowError(
          "OWNERSHIP_CHANGED",
          "異なる申告主体の販売に影響するため処理できません。",
        );
      row.consumptionId = match.id;
      usedConsumption.add(match.id);
    }
    if (["RETURN_IN", "RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(m.movementType)) {
      if (m.sourceType === "listing") {
        const matches = movements.filter(
          (x) =>
            x.operationId === m.operationId &&
            x.itemVariantId === m.itemVariantId &&
            x.inventoryLotId === m.inventoryLotId &&
            x.quantity === -m.quantity &&
            x.storageLocationFromId === m.storageLocationToId &&
            x.quantity < 0,
        );
        if (matches.length !== 1)
          throw new WorkflowError("HISTORY_INCOMPLETE", "完了前返送の原価を照合できません。");
        row.mirrorOutId = matches[0]!.id;
      } else {
        const matches = dispositions.filter(
          (x) =>
            !usedDisposition.has(x.id) &&
            x.salesReturnLine.salesReturnId === m.sourceId &&
            x.itemVariantId === m.itemVariantId &&
            x.inventoryLotId === m.inventoryLotId &&
            x.storageLocationId === m.storageLocationToId &&
            x.quantity === m.quantity &&
            x.costTotalJpy === m.costTotalJpy &&
            x.disposition ===
              { RETURN_IN: "RESTOCK", RETURN_DEFECTIVE: "DEFECTIVE", RETURN_DISPOSAL: "DISPOSED" }[
                m.movementType as "RETURN_IN"
              ],
        );
        if (matches.length !== 1 || !matches[0]!.consumptionId)
          throw new WorkflowError("HISTORY_INCOMPLETE", "返品と販売時原価の対応を確認できません。");
        const d = matches[0]!,
          consumption = consumptions.find((x) => x.id === d.consumptionId);
        if (!consumption)
          throw new WorkflowError("HISTORY_INCOMPLETE", "返品元の販売原価がありません。");
        row.returnId = d.id;
        row.returnConsumptionId = consumption.id;
        row.returnConsumptionQuantity = consumption.quantity;
        usedDisposition.add(d.id);
      }
    }
    sourceRows.set(m.id, row);
  }
  const observations = await tx.stocktakeObservation.findMany({
    where: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      itemVariantId: { in: ids },
    },
  });
  const observedOperations = await tx.inventoryOperation.findMany({
    where: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      id: { in: observations.map((s) => s.operationId) },
    },
  });
  if (observations.some((s) => s.reportingEntityId !== c.reportingEntityId))
    throw new WorkflowError("OWNERSHIP_CHANGED", "異なる申告主体の実測記録に影響します。");
  const originalOperations = [
    ...new Map(
      [
        ...movements.map((m) => m.operation),
        ...uniqueMovements.map((m) => m.operation),
        ...observedOperations,
      ].map((o) => [o.id, o]),
    ).values(),
  ];
  const timeline = await effectiveOperationTimeline(tx, originalOperations);
  const operations = originalOperations
    .map((o) => ({
      ...o,
      occurredAt: new Date(`${timeline.get(o.id)!.date}T00:00:00+09:00`),
      valuationOrder: new Precise(timeline.get(o.id)!.order),
    }))
    .sort(
      (a, b) =>
        day(a.occurredAt).localeCompare(day(b.occurredAt)) ||
        a.valuationOrder.comparedTo(b.valuationOrder) ||
        a.id.localeCompare(b.id),
    );
  const sameDay = operations.filter((o) => day(o.occurredAt) === date);
  const choices = sameDay.map((o) => ({
    id: o.id,
    label: `${({ PURCHASE_RECEIPT: "仕入れの入庫", SALE_COMPLETION: "取引完了", SALE_RETURN: "返品", ADJUSTMENT_IN: "在庫増加", LOCATION_TRANSFER: "場所移動" } as Record<string, string>)[o.operationType] ?? "在庫操作"}（${o.sourceId.slice(0, 8)}）より前`,
  }));
  choices.push({ id: "LAST", label: "同日の記録の後" });
  if (position && !choices.some((x) => x.id === position))
    throw new WorkflowError("CONFLICT", "同日の取引が変更されました。順序を選び直してください。");
  const runAt = (selected: string) => {
    const before = sameDay.find((o) => o.id === selected),
      index = before ? sameDay.indexOf(before) : -1;
    const order = before
      ? new Precise(before.valuationOrder.toString())
          .plus(
            index > 0
              ? sameDay[index - 1]!.valuationOrder.toString()
              : new Precise(before.valuationOrder.toString()).minus(2),
          )
          .div(2)
      : new Precise(sameDay.at(-1)?.valuationOrder.toString() ?? "0")
          .plus(new Precise(sameDay.at(-1)?.valuationOrder.toString() ?? "0").floor().plus(1))
          .div(2);
    const storedOrder = new Precise(order.toFixed(30));
    assertFixedStocktakes(
      [
        ...operations.map((o) => ({
          id: o.id,
          date: day(o.occurredAt),
          order: o.valuationOrder.toString(),
          movements: movements.filter((m) => m.operationId === o.id),
        })),
        {
          id: "pending",
          date,
          order: storedOrder.toString(),
          movements: rows
            .filter((r) => !r.uniqueStockUnitId)
            .map((r) => ({
              itemVariantId: r.itemVariantId,
              uniqueStockUnitId: null,
              movementType: "SALE_OUT",
              quantity: -r.quantity,
              storageLocationFromId: r.storageLocationId,
              storageLocationToId: null,
            })),
        },
      ],
      observations,
    );
    if (
      (before && storedOrder.greaterThanOrEqualTo(before.valuationOrder.toString())) ||
      (index > 0 && storedOrder.lessThanOrEqualTo(sameDay[index - 1]!.valuationOrder.toString())) ||
      (!before &&
        sameDay.length &&
        storedOrder.lessThanOrEqualTo(sameDay.at(-1)!.valuationOrder.toString()))
    )
      throw new WorkflowError(
        "HISTORY_INCOMPLETE",
        "同日の計算順序を安全に追加できません。履歴の確認が必要です。",
      );
    const result: CompletionValuation = {
      fingerprint: "",
      order: order.toFixed(30),
      cost: 0n,
      final:
        rows.every(
          (r) => (r.inventoryLot ?? r.uniqueStockUnit?.inventoryLot)?.costStatus === "FINAL",
        ) && movements.every((m) => !m.inventoryLot || m.inventoryLot.costStatus === "FINAL"),
      pendingCosts: new Map(),
      balances: new Map(),
      changes: [],
      choices,
      requiresOrder: false,
      orderImpacts: [],
    };
    for (const id of ids) {
      const vm = movements.filter((m) => m.itemVariantId === id),
        b = balances.find((b) => b.itemVariantId === id);
      const ledgerQty = vm
        .filter(
          (m) =>
            !["LOCATION_TRANSFER", "RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(m.movementType),
        )
        .reduce((s, m) => s + m.quantity, 0);
      const ledgerCost = vm
        .filter(
          (m) =>
            !["LOCATION_TRANSFER", "RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(m.movementType),
        )
        .reduce((s, m) => s + mc.get(m.id)!, 0n);
      if (
        !b ||
        b.quantity !== ledgerQty ||
        b.carryingCostTotalJpy !== ledgerCost ||
        b.quantity !== (lotTotals.find((l) => l.itemVariantId === id)?._sum.remainingQuantity ?? 0)
      )
        throw new WorkflowError(
          "HISTORY_INCOMPLETE",
          "履歴と現在の在庫・原価残高が一致しません。再計算は確定せず入力を保持します。",
        );
      const pending: ValuationEvent = {
        id: "pending",
        rows: rows
          .filter((r) => r.itemVariantId === id && !r.uniqueStockUnitId)
          .map((r) => ({
            id: `pending:${r.id}`,
            kind: "SALE_OUT",
            quantity: -r.quantity,
            cost: 0n,
            consumptionId: `pending:${r.id}`,
          })),
      };
      const events = operations
        .filter((o) => vm.some((m) => m.operationId === o.id))
        .map((o) => ({
          id: o.id,
          day: day(o.occurredAt),
          order: o.valuationOrder.toString(),
          rows: orderedReturnMovements(vm.filter((m) => m.operationId === o.id)).map(
            (m) => sourceRows.get(m.id)!,
          ),
        }));
      events.push({ ...pending, day: date, order: result.order });
      events.sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          new Precise(a.order).comparedTo(b.order) ||
          a.id.localeCompare(b.id),
      );
      const insertion = events.findIndex((e) => e.id === "pending");
      const replay = replayValuation(
        events.map((event, index) => ({ ...event, preserveCosts: index < insertion })),
      );
      result.balances.set(id, {
        quantity: replay.quantity,
        before: b.carryingCostTotalJpy,
        after: replay.cost,
      });
      for (const r of pending.rows) {
        const cost = replay.consumptionCosts.get(r.consumptionId!)!;
        result.pendingCosts.set(r.id.slice(8), cost);
        result.cost += cost;
      }
      for (const m of vm) {
        const after = replay.movementCosts.get(m.id)!;
        if (after !== mc.get(m.id))
          result.changes.push({
            type: "MOVEMENT",
            id: m.id,
            before: mc.get(m.id)!,
            after,
            date: timeline.get(m.operationId)!.date,
            orderId: m.movementType === "SALE_OUT" ? m.sourceId : undefined,
          });
      }
      for (const x of consumptions.filter((x) => x.itemVariantId === id)) {
        const after = replay.consumptionCosts.get(x.id);
        if (after === undefined)
          throw new WorkflowError("HISTORY_INCOMPLETE", "販売原価に対応する出庫がありません。");
        if (after !== cc.get(x.id))
          result.changes.push({
            type: "CONSUMPTION",
            id: x.id,
            before: cc.get(x.id)!,
            after,
            date: timeline.get(
              vm.find((m) => sourceRows.get(m.id)?.consumptionId === x.id)!.operationId,
            )!.date,
            orderId: x.salesOrderLine.salesOrderId,
          });
      }
      for (const d of dispositions.filter((x) => x.itemVariantId === id)) {
        const after = replay.dispositionCosts.get(d.id);
        if (after === undefined)
          throw new WorkflowError("HISTORY_INCOMPLETE", "返品原価に対応する移動がありません。");
        if (after !== dc.get(d.id))
          result.changes.push({
            type: "DISPOSITION",
            id: d.id,
            before: dc.get(d.id)!,
            after,
            date: timeline.get(
              vm.find((m) => sourceRows.get(m.id)?.returnId === d.id)!.operationId,
            )!.date,
            orderId: d.salesReturnLine.salesReturn.salesOrderId,
          });
      }
    }
    for (const r of rows.filter((r) => r.uniqueStockUnitId)) {
      const own = uniqueMovements.filter(
        (m) =>
          m.uniqueStockUnitId === r.uniqueStockUnitId &&
          !["LOCATION_TRANSFER", "RETURN_DEFECTIVE", "RETURN_DISPOSAL"].includes(m.movementType),
      );
      const events = own.map((m) => ({
        day: timeline.get(m.operationId)!.date,
        order: timeline.get(m.operationId)!.order,
        quantity: m.quantity,
        id: m.operation.id,
      }));
      if (own.reduce((s, m) => s + m.costTotalJpy, 0n) !== r.uniqueStockUnit!.acquisitionCostJpy)
        throw new WorkflowError(
          "HISTORY_INCOMPLETE",
          "個体の原価履歴と個別原価が一致しません。入庫・返送記録を確認してください。",
        );
      events.push({ day: date, order: result.order, quantity: -1, id: "pending" });
      events.sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          new Precise(a.order).comparedTo(b.order) ||
          a.id.localeCompare(b.id),
      );
      let count = 0;
      for (const event of events) {
        count += event.quantity;
        if (count < 0 || count > 1)
          throw new WorkflowError(
            "HISTORY_INCOMPLETE",
            "個体が指定した完了日には在庫にありません。入庫・元の販売・返送の前後関係を確認してください。",
          );
      }
      if (count !== 0)
        throw new WorkflowError(
          "HISTORY_INCOMPLETE",
          "個体の入出庫履歴と現在の状態が一致しません。",
        );
      result.pendingCosts.set(r.id, r.uniqueStockUnit!.acquisitionCostJpy);
      result.cost += r.uniqueStockUnit!.acquisitionCostJpy;
    }
    return result;
  };
  let selected: CompletionValuation;
  if (!position && sameDay.length) {
    const alternatives = choices.map((choice) => {
      try {
        return { value: runAt(choice.id) };
      } catch (error) {
        return { error };
      }
    });
    const signature = (v: CompletionValuation) =>
      fingerprint({ cost: v.cost, balances: [...v.balances], changes: v.changes });
    const signatures = new Set(alternatives.map((a) => (a.value ? signature(a.value) : "invalid")));
    if (signatures.size > 1) {
      const valid = alternatives.find((a) => a.value)?.value;
      if (!valid) throw alternatives[0]!.error;
      return { ...valid, fingerprint: "", requiresOrder: true };
    }
    const last = alternatives.at(-1)!;
    if (!last.value) throw last.error;
    selected = last.value;
  } else selected = runAt(position ?? "LAST");
  for (const change of selected.changes) {
    const fiscal = fiscals.find(
      (f) =>
        f.effectiveFrom.toISOString().slice(0, 10) <= change.date &&
        f.effectiveTo.toISOString().slice(0, 10) >= change.date,
    )?.fiscalYearProfile;
    if (!fiscal)
      throw new WorkflowError("HISTORY_INCOMPLETE", `${change.date}の年度別割当がありません。`);
    if (fiscal.reportingEntityId !== c.reportingEntityId)
      throw new WorkflowError(
        "OWNERSHIP_CHANGED",
        "別の申告主体の原価に影響します。在庫移管を確認してください。",
      );
    await tx.$queryRaw`SELECT id FROM fiscal_year_profile WHERE id=${fiscal.id}::uuid FOR SHARE`;
    const fresh = await tx.fiscalYearProfile.findUniqueOrThrow({ where: { id: fiscal.id } });
    if (fresh.status === "LOCKED")
      throw new WorkflowError(
        "YEAR_LOCKED",
        `${fresh.year}年度の確定原価が変わるため記録できません。入力は保持しています。`,
      );
  }
  const affectedIds = [...new Set(selected.changes.flatMap((x) => (x.orderId ? [x.orderId] : [])))];
  const affectedOrders = await tx.salesOrder.findMany({
    where: {
      id: { in: affectedIds },
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
    },
    include: {
      lines: { include: { salesSku: true } },
      returns: { include: { lines: { include: { dispositions: true } } } },
    },
  });
  for (const order of affectedOrders) {
    const beforeCost = order.lines.some((l) => l.managementCogsJpy === null)
      ? null
      : order.lines.reduce((s, l) => s + l.managementCogsJpy!, 0n);
    const afterCost =
      beforeCost === null
        ? null
        : beforeCost +
          selected.changes
            .filter((x) => x.type === "CONSUMPTION" && x.orderId === order.id)
            .reduce((s, x) => s + x.after - x.before, 0n);
    const good = order.returns
        .flatMap((r) => r.lines.flatMap((l) => l.dispositions))
        .filter((d) => d.disposition === "RESTOCK"),
      currentCosts = await effectiveCosts(tx, "DISPOSITION", good);
    const returnedBefore = [...currentCosts.values()].reduce((s, v) => s + v, 0n),
      returnedAfter =
        returnedBefore +
        selected.changes
          .filter((x) => x.type === "DISPOSITION" && good.some((d) => d.id === x.id))
          .reduce((s, x) => s + x.after - x.before, 0n);
    const refundDelta = order.returns.reduce(
      (s, r) => s - r.salesRefundJpy + r.feeRefundJpy + r.shippingRefundJpy,
      0n,
    );
    const profit = (cost: bigint | null, returned: bigint, final: boolean) => {
      const value = confirmedProfit({
        revenue: order.grossSalesJpy,
        discount: order.discountJpy,
        costs: [order.feeJpy, order.shippingJpy, order.packingJpy, order.otherCostJpy],
        cogs: cost,
        finalCost: final,
      });
      return value === null ? null : value + refundDelta + returned;
    };
    selected.orderImpacts.push({
      id: order.id,
      name: order.lines.map((l) => l.salesSku.name).join("、"),
      date: day(order.completedAt!),
      beforeCost,
      afterCost,
      beforeProfit: profit(beforeCost, returnedBefore, order.costStatus === "FINAL"),
      afterProfit: profit(afterCost, returnedAfter, order.costStatus === "FINAL" && selected.final),
    });
  }
  selected.fingerprint = fingerprint({
    listingId,
    date,
    position: position ?? "LAST",
    year: c.year,
    entity: c.reportingEntityId,
    revision: revision?.revision ?? 0n,
    rows,
    movements: movements.map((m) => [m.id, mc.get(m.id)]),
    consumptions: [...cc],
    dispositions: [...dc],
    timeline: [...timeline],
    observations,
    fiscals: fiscals.map((f) => [f.id, f.updatedAt, f.fiscalYearProfile.status]),
    order: selected.order,
  });
  return selected;
}

export async function applyCompletionValuation(
  tx: Tx,
  c: WorkflowContext,
  key: string,
  orderId: string,
  plan: CompletionValuation,
) {
  const run = await tx.valuationRun.create({
    data: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      operatorId: c.operatorId,
      requestId: key,
      sourceOrderId: orderId,
      summary: toJson({
        cost: plan.cost,
        balances: [...plan.balances],
        changes: plan.changes,
        orderImpacts: plan.orderImpacts,
        order: plan.order,
      }),
    },
  });
  if (plan.changes.length)
    await tx.valuationAdjustment.createMany({
      data: plan.changes.map((x) => ({
        runId: run.id,
        targetType: x.type,
        targetId: x.id,
        beforeJpy: x.before,
        afterJpy: x.after,
        deltaJpy: x.after - x.before,
      })),
    });
  for (const [id, b] of plan.balances)
    await tx.inventoryCostBalance.update({
      where: {
        itemVariantId_businessUnitId_trackingMode: {
          itemVariantId: id,
          businessUnitId: c.businessUnitId,
          trackingMode: "QUANTITY",
        },
      },
      data: {
        quantity: b.quantity,
        carryingCostTotalJpy: b.after,
        averageUnitCostJpy: b.quantity ? averageUnitCost(b.after, b.quantity) : "0",
      },
    });
  const orders = [
    ...new Set(
      plan.changes.filter((x) => x.type === "CONSUMPTION" && x.orderId).map((x) => x.orderId!),
    ),
  ];
  for (const id of orders) {
    const lines = await tx.salesOrderLine.findMany({
      where: { salesOrderId: id },
      include: { consumptions: true },
    });
    for (const line of lines) {
      const costs = await effectiveCosts(tx, "CONSUMPTION", line.consumptions);
      await tx.salesOrderLine.update({
        where: { id: line.id },
        data: { managementCogsJpy: [...costs.values()].reduce((s, x) => s + x, 0n) },
      });
    }
    await tx.salesOrder.update({
      where: { id },
      data: { revision: { increment: 1 }, ...(!plan.final ? { costStatus: "PROVISIONAL" } : {}) },
    });
  }
}
