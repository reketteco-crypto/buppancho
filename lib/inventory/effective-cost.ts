import type { Prisma } from "@/generated/prisma/client";
export type CostTarget = "MOVEMENT" | "CONSUMPTION" | "DISPOSITION";
export async function effectiveCosts(
  db: Pick<Prisma.TransactionClient, "valuationAdjustment" | "receiptCostCorrection">,
  type: CostTarget,
  rows: { id: string; costTotalJpy: bigint }[],
) {
  const values = new Map(rows.map((r) => [r.id, r.costTotalJpy]));
  if (!rows.length) return values;
  const changes = await db.valuationAdjustment.findMany({
    where: { targetType: type, targetId: { in: rows.map((r) => r.id) } },
    orderBy: { run: { sequence: "asc" } },
  });
  for (const change of changes) values.set(change.targetId, change.afterJpy);
  if (type === "MOVEMENT") {
    const receipts = await db.receiptCostCorrection.findMany({
      where: { movementId: { in: rows.map((r) => r.id) } },
      orderBy: { sequence: "asc" },
    });
    for (const correction of receipts) values.set(correction.movementId, correction.afterJpy);
  }
  return values;
}
