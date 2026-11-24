import type { requireInventoryContext } from "@/lib/inventory/context";
import { movingAverageOutCost } from "@/lib/inventory/money";
import { z } from "zod";
export async function recoveryRequest(
  c: Awaited<ReturnType<typeof requireInventoryContext>>,
  id: string | undefined,
  kind: string,
) {
  if (!id || !z.uuid().safeParse(id).success) return null;
  return c.db.workflowRequest.findFirst({
    where: {
      id,
      kind,
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      operatorId: c.operatorId,
      userAccountId: c.session.userAccountId,
      year: c.fiscalYear.year,
    },
  });
}
export function listingLabel(row: {
  workflowVersion: number;
  status: string;
  returnPending: boolean;
  completion?: { id: string } | null;
  orderLines?: { salesOrder: { completedAt: Date | null } }[];
}) {
  if (row.returnPending) return "返送確認待ち";
  if (row.completion) return "完了記録済み";
  if (
    row.workflowVersion === 1 &&
    row.status === "SOLD_OUT" &&
    row.orderLines?.some((l) => l.salesOrder.completedAt)
  )
    return "旧記録・完了実績あり";
  if (row.workflowVersion === 1 && row.status === "SOLD_OUT") return "旧記録・完了未登録";
  return (
    (
      {
        DRAFT: "出品準備",
        ACTIVE: "完了未記録",
        PAUSED: "一時停止",
        ENDED: "終了",
        SOLD_OUT: "旧記録・要確認",
      } as Record<string, string>
    )[row.status] ?? row.status
  );
}
export function inputContext(c: Awaited<ReturnType<typeof requireInventoryContext>>) {
  return {
    businessUnitId: c.businessUnitId,
    operatorId: c.operatorId,
    year: c.fiscalYear.year,
    reportingEntityId: c.reportingEntityId,
  };
}
export async function productOptions(c: Awaited<ReturnType<typeof requireInventoryContext>>) {
  const variants = await c.db.itemVariant.findMany({
    where: {
      active: true,
      inventoryItem: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
    },
    include: {
      inventoryItem: true,
      costBalances: true,
      uniqueStockUnits: true,
      inventoryReservations: { where: { status: "RESERVED" } },
    },
    orderBy: { variantCode: "asc" },
  });
  return variants.flatMap((v) => {
    const balance = v.costBalances.find((b) => b.trackingMode === "QUANTITY");
    const label =
      `${v.inventoryItem.name} ${Object.values(v.attributesJson as Record<string, string>).join(" / ")}`.trim();
    const held = v.inventoryReservations
      .filter((r) => !r.uniqueStockUnitId)
      .reduce((s, r) => s + r.quantity, 0);
    return [
      ...(balance
        ? [
            {
              id: v.id,
              label,
              unique: false,
              available: Math.max(0, balance.quantity - held),
              cost: balance.quantity
                ? movingAverageOutCost(balance.carryingCostTotalJpy, balance.quantity, 1).toString()
                : null,
            },
          ]
        : []),
      ...v.uniqueStockUnits
        .filter((u) => ["IN_STOCK", "RESERVED"].includes(u.status))
        .map((u) => ({
          id: u.id,
          label: `${label} / ${u.individualCode} / ${u.condition}`,
          unique: true,
          available:
            u.status === "IN_STOCK" &&
            !v.inventoryReservations.some((r) => r.uniqueStockUnitId === u.id)
              ? 1
              : 0,
          cost: u.acquisitionCostJpy.toString(),
        })),
    ];
  });
}
