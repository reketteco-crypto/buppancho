import type { Prisma } from "@/generated/prisma/client";
export const eventDay = (date: Date) =>
  date.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
export async function hasLaterInventoryEvents(
  db: Pick<Prisma.TransactionClient, "eventDateCorrection" | "inventoryOperation">,
  scope: { workspaceId: string; businessUnitId: string },
  variantIds: string[],
  date: string,
) {
  if (!variantIds.length) return false;
  // A caller may pass a full WorkflowContext; TypeScript does not strip its runtime keys.
  const operations = await db.inventoryOperation.findMany({
    where: {
      workspaceId: scope.workspaceId,
      businessUnitId: scope.businessUnitId,
      movements: { some: { itemVariantId: { in: variantIds } } },
    },
  });
  return [...(await effectiveOperationDates(db, operations)).values()].some((d) => d > date);
}
export async function effectiveSourceDates(
  db: Pick<Prisma.TransactionClient, "eventDateCorrection" | "inventoryOperation">,
  scope: { workspaceId: string; businessUnitId: string },
  sourceType: string,
  records: { id: string; date: Date }[],
) {
  const dates = new Map(records.map((r) => [r.id, eventDay(r.date)]));
  if (!records.length) return dates;
  const operations = await db.inventoryOperation.findMany({
    where: {
      workspaceId: scope.workspaceId,
      businessUnitId: scope.businessUnitId,
      sourceType,
      sourceId: { in: records.map((r) => r.id) },
      ...(sourceType === "sales_order" ? { operationType: "SALE_COMPLETION" as const } : {}),
    },
  });
  const effective = await effectiveOperationDates(db, operations);
  for (const operation of operations) dates.set(operation.sourceId, effective.get(operation.id)!);
  return dates;
}
export async function effectiveLotReceiptDates(
  db: Pick<Prisma.TransactionClient, "eventDateCorrection" | "stockMovement">,
  lotIds: string[],
) {
  if (!lotIds.length) return new Map<string, string>();
  const receipts = await db.stockMovement.findMany({
    where: { inventoryLotId: { in: lotIds }, movementType: { in: ["RECEIPT", "ADJUSTMENT_IN"] } },
    include: { operation: true },
  });
  const timeline = await effectiveOperationDates(
    db,
    receipts.map((r) => r.operation),
  );
  const dates = new Map<string, string>();
  for (const receipt of receipts) {
    const date = timeline.get(receipt.operationId)!;
    if (
      receipt.inventoryLotId &&
      (!dates.has(receipt.inventoryLotId) || date < dates.get(receipt.inventoryLotId)!)
    )
      dates.set(receipt.inventoryLotId, date);
  }
  return dates;
}
export async function effectiveOperationDates(
  db: Pick<Prisma.TransactionClient, "eventDateCorrection">,
  operations: { id: string; occurredAt: Date }[],
) {
  const timeline = await effectiveOperationTimeline(db, operations);
  return new Map([...timeline].map(([id, event]) => [id, event.date]));
}

/** Original event dates are immutable; all consumers resolve append-only corrections here. */
export async function effectiveOperationTimeline(
  db: Pick<Prisma.TransactionClient, "eventDateCorrection">,
  operations: { id: string; occurredAt: Date; valuationOrder?: { toString(): string } }[],
) {
  const timeline = new Map(
    operations.map((o) => [
      o.id,
      {
        date: eventDay(o.occurredAt),
        order: o.valuationOrder?.toString() ?? "0",
      },
    ]),
  );
  if (!operations.length) return timeline;
  const corrections = await db.eventDateCorrection.findMany({
    where: { operationId: { in: operations.map((o) => o.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const correction of corrections) {
    const prior = timeline.get(correction.operationId);
    if (prior)
      timeline.set(correction.operationId, {
        date: correction.effectiveDate.toISOString().slice(0, 10),
        order: correction.valuationOrder?.toString() ?? prior.order,
      });
  }
  return timeline;
}
