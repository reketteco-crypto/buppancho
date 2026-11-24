import type { Prisma } from "@/generated/prisma/client";
type Client = Pick<Prisma.TransactionClient, "inventoryReservation" | "stockMovement">;
export async function reservationConflicts(
  db: Client,
  workspaceId: string,
  businessUnitId: string,
) {
  const rows = await db.inventoryReservation.findMany({
    where: { status: "RESERVED", itemVariant: { inventoryItem: { workspaceId, businessUnitId } } },
    include: { inventoryLot: true, uniqueStockUnit: true, salesOrderLine: true, itemVariant: true },
  });
  const problems: Array<{
    reservationId: string;
    listingId: string | null;
    orderId: string | null;
    itemId: string;
    message: string;
  }> = [];
  for (const r of rows) {
    let message = "";
    if (r.uniqueStockUnitId) {
      if (
        r.uniqueStockUnit?.status !== "RESERVED" ||
        r.uniqueStockUnit.storageLocationId !== r.storageLocationId
      )
        message = "個体の状態・確保先が一致しません";
    } else if (r.inventoryLot) {
      const held = rows.filter((v) => v.inventoryLotId === r.inventoryLotId);
      if (held.reduce((s, v) => s + v.quantity, 0) > r.inventoryLot.remainingQuantity)
        message = "ロットの残数より確保数が多くなっています";
      else {
        const movements = await db.stockMovement.findMany({
          where: {
            inventoryLotId: r.inventoryLotId,
            uniqueStockUnitId: null,
            movementType: { notIn: ["RETURN_DEFECTIVE", "RETURN_DISPOSAL"] },
          },
        });
        const balance = movements.reduce(
          (s, m) =>
            s +
            (m.storageLocationToId === r.storageLocationId ? Math.abs(m.quantity) : 0) -
            (m.storageLocationFromId === r.storageLocationId ? Math.abs(m.quantity) : 0),
          0,
        );
        if (
          held
            .filter((v) => v.storageLocationId === r.storageLocationId)
            .reduce((s, v) => s + v.quantity, 0) > balance
        )
          message = "保管場所の残数より確保数が多くなっています";
      }
    }
    if (message)
      problems.push({
        reservationId: r.id,
        listingId: r.listingId,
        orderId: r.salesOrderLine?.salesOrderId ?? null,
        itemId: r.itemVariant.inventoryItemId,
        message,
      });
  }
  return problems;
}
