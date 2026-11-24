import type { Prisma } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { effectiveCosts } from "@/lib/inventory/effective-cost";
import { effectiveSourceDates, effectiveOperationDates } from "@/lib/inventory/event-dates";
type Db = Prisma.TransactionClient;
/** Managerial accrual totals. Material usage is deliberately excluded from business expense. */
export async function businessReport(
  db: Db,
  c: Pick<WorkflowContext, "workspaceId" | "businessUnitId" | "reportingEntityId">,
  start: string,
  end: string,
) {
  const scope = {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      reportingEntityId: c.reportingEntityId,
    },
    inside = (date: string) => date >= start && date <= end;
  const [orders, returns, documents, charges, others, moves, supplierReturns, transfers] =
    await Promise.all([
      db.salesOrder.findMany({
        where: { ...scope, completedAt: { not: null }, status: { in: ["COMPLETED", "RETURNED"] } },
        include: { lines: true },
      }),
      db.salesReturn.findMany({
        where: { salesOrder: scope },
        include: { lines: { include: { dispositions: true } } },
      }),
      db.purchaseDocument.findMany({
        where: {
          ...scope,
          status: { not: "CANCELLED" },
          purchasedDate: { gte: new Date(start), lte: new Date(end) },
        },
        include: { lines: true },
      }),
      db.purchaseCharge.findMany({
        where: {
          supersededBy: null,
          OR: [{ document: { ...scope, status: { not: "CANCELLED" } } }, { delivery: scope }],
        },
        include: {
          document: { include: { lines: true } },
          delivery: { include: { lines: { include: { purchaseLine: true } } } },
          allocations: { include: { line: true } },
        },
      }),
      db.otherRecord.findMany({
        where: { ...scope, date: { gte: new Date(start), lte: new Date(end) } },
      }),
      db.stockMovement.findMany({
        where: {
          businessUnitId: c.businessUnitId,
          operation: { workspaceId: c.workspaceId },
          movementType: {
            in: [
              "DISPOSAL",
              "LOSS",
              "PERSONAL_USE",
              "ADJUSTMENT_OUT",
              "ADJUSTMENT_IN",
              "PURCHASE_RETURN",
            ],
          },
        },
        include: { operation: true },
      }),
      db.supplierReturn.findMany({
        where: { receiptLine: { receipt: scope } },
        include: { receiptLine: true },
      }),
      db.moneyTransaction.findMany({
        where: { ...scope, date: { gte: new Date(start), lte: new Date(end) }, feeJpy: { gt: 0 } },
      }),
    ]);
  const [saleDates, moveDates, moveCosts, dispositionCosts] = await Promise.all([
    effectiveSourceDates(
      db,
      c,
      "sales_order",
      orders.map((o) => ({ id: o.id, date: o.completedAt! })),
    ),
    effectiveOperationDates(
      db,
      moves.map((m) => m.operation),
    ),
    effectiveCosts(db, "MOVEMENT", moves),
    effectiveCosts(
      db,
      "DISPOSITION",
      returns.flatMap((r) => r.lines.flatMap((l) => l.dispositions)),
    ),
  ]);
  const requestKeys = new Map(
    moves.map((m) => [m.operationId, m.operation.idempotencyKey.slice(0, 36)]),
  );
  const facts = await db.workflowEvent.findMany({
    where: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      id: { in: [...new Set(requestKeys.values())].filter((id) => /^[0-9a-f-]{36}$/.test(id)) },
    },
    select: { id: true, detail: true },
  });
  const owners = new Map(
    facts.map((f) => {
      const detail = f.detail as {
        request?: {
          context?: { reportingEntityId?: string };
          inputOrigin?: { reportingEntityId?: string };
        };
      };
      return [
        f.id,
        detail.request?.context?.reportingEntityId ??
          detail.request?.inputOrigin?.reportingEntityId,
      ];
    }),
  );
  let revenue = 0n,
    cogs = 0n,
    salesExpenses = 0n,
    purchasesExpense = 0n,
    otherIncome = 0n,
    otherExpense = 0n,
    stockExpense = 0n,
    transferFees = 0n,
    provisional = 0;
  const periodOrders = orders.filter((o) => inside(saleDates.get(o.id)!));
  const periodOrderIds = new Set(periodOrders.map((o) => o.id));
  for (const o of periodOrders) {
    revenue += o.grossSalesJpy - o.discountJpy;
    cogs += o.lines.reduce((s, l) => s + (l.managementCogsJpy ?? 0n), 0n);
    salesExpenses +=
      (o.feeJpy ?? 0n) + (o.shippingJpy ?? 0n) + (o.packingJpy ?? 0n) + (o.otherCostJpy ?? 0n);
    if (
      o.costStatus !== "FINAL" ||
      o.lines.some((l) => l.managementCogsJpy === null) ||
      [o.feeJpy, o.shippingJpy, o.packingJpy, o.otherCostJpy].some((v) => v === null)
    )
      provisional++;
  }
  for (const r of returns.filter((r) => periodOrderIds.has(r.salesOrderId))) {
    revenue -= r.salesRefundJpy;
    salesExpenses -= r.feeRefundJpy + r.shippingRefundJpy;
    cogs -= r.lines
      .flatMap((l) => l.dispositions)
      .filter((d) => d.disposition === "RESTOCK")
      .reduce((s, d) => s + dispositionCosts.get(d.id)!, 0n);
  }
  for (const p of documents)
    for (const l of p.lines) if (l.purpose !== "STOCK") purchasesExpense += l.productAmountJpy;
  for (const charge of charges) {
    const date =
      charge.recordedDate?.toISOString().slice(0, 10) ??
      charge.document?.purchasedDate.toISOString().slice(0, 10) ??
      charge.delivery!.shippedDate.toISOString().slice(0, 10);
    if (!inside(date)) continue;
    const targets = charge.basisSnapshot as { targets?: string[] } | null;
    const source = charge.document?.lines ?? charge.delivery!.lines.map((l) => l.purchaseLine),
      relevant = source.some(
        (l) => l.purpose !== "STOCK" && (!targets?.targets || targets.targets.includes(l.id)),
      );
    if (!charge.capitalized) {
      if (charge.amountJpy === null) provisional++;
      else purchasesExpense += charge.amountJpy;
    } else {
      purchasesExpense += charge.allocations
        .filter((a) => a.line.purpose !== "STOCK")
        .reduce((s, a) => s + a.amountJpy, 0n);
      if (relevant && !charge.allocated) provisional++;
    }
    if (charge.reason && !charge.recordedDate) provisional++;
  }
  for (const r of others)
    if (r.kind === "INCOME") otherIncome += r.amountJpy;
    else otherExpense += r.amountJpy;
  for (const m of moves.filter(
    (m) => m.movementType !== "PURCHASE_RETURN" && inside(moveDates.get(m.operationId)!),
  )) {
    const owner = owners.get(requestKeys.get(m.operationId)!);
    if (!owner) provisional++;
    else if (owner === c.reportingEntityId) stockExpense -= moveCosts.get(m.id)!;
  }
  for (const r of supplierReturns.filter((r) =>
    inside(moveDates.get(r.operationId) ?? r.returnedDate.toISOString().slice(0, 10)),
  )) {
    const cost = moves
      .filter((m) => m.operationId === r.operationId)
      .reduce((s, m) => s - (moveCosts.get(m.id) ?? 0n), 0n);
    if (r.refundJpy === null) provisional++;
    else otherIncome += r.refundJpy - cost;
  }
  for (const t of transfers) transferFees += (t.kind === "REVERSAL" ? -1n : 1n) * t.feeJpy;
  const expenses =
      cogs + salesExpenses + purchasesExpense + otherExpense + stockExpense + transferFees,
    knownProfit = revenue + otherIncome - expenses;
  return {
    start,
    end,
    revenue,
    otherIncome,
    cogs,
    salesExpenses,
    purchasesExpense,
    otherExpense,
    stockExpense,
    transferFees,
    expenses,
    knownProfit,
    profit: provisional ? null : knownProfit,
    provisional,
  };
}
