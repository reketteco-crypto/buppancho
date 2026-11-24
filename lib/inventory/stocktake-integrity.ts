import type { Prisma } from "@/generated/prisma/client";
import type { WorkflowContext } from "@/lib/sales/workflow-context";
import { effectiveOperationTimeline } from "@/lib/inventory/event-dates";
import { assertFixedStocktakes } from "@/lib/inventory/stocktake-ledger";
import { WorkflowError } from "@/lib/sales/workflow-errors";

export async function assertStoredStocktakes(tx: Prisma.TransactionClient, c: WorkflowContext) {
  const observations = await tx.stocktakeObservation.findMany({
    where: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
  });
  if (!observations.length) return;
  const ids = [...new Set(observations.map((s) => s.itemVariantId))];
  const operations = await tx.inventoryOperation.findMany({
    where: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      OR: [
        { movements: { some: { itemVariantId: { in: ids }, uniqueStockUnitId: null } } },
        { id: { in: observations.map((s) => s.operationId) } },
      ],
    },
    include: { movements: { where: { itemVariantId: { in: ids }, uniqueStockUnitId: null } } },
  });
  const timeline = await effectiveOperationTimeline(tx, operations);
  // Validate historical ownership against the event's assignment, not the currently selected year.
  const assignments = await tx.businessUnitAssignment.findMany({
    where: { businessUnitId: c.businessUnitId },
    include: { fiscalYearProfile: true },
  });
  for (const observation of observations) {
    const date = timeline.get(observation.operationId)?.date;
    if (
      !date ||
      !assignments.some(
        (a) =>
          a.effectiveFrom.toISOString().slice(0, 10) <= date &&
          a.effectiveTo.toISOString().slice(0, 10) >= date &&
          a.fiscalYearProfile.reportingEntityId === observation.reportingEntityId,
      )
    )
      throw new WorkflowError(
        "OWNERSHIP_CHANGED",
        "実測記録の帰属を確認できません。年度別割当を確認してください。",
      );
  }
  assertFixedStocktakes(
    operations.map((o) => ({ id: o.id, ...timeline.get(o.id)!, movements: o.movements })),
    observations,
  );
}
