import type { Prisma } from "@/generated/prisma/client";
import { skuAvailability } from "@/lib/sales/availability";

type QueryClient = Pick<
  Prisma.TransactionClient,
  "inventoryReservation" | "inventoryCostBalance" | "uniqueStockUnit"
>;

export async function getSkuAvailability(
  db: QueryClient,
  businessUnitId: string,
  components: Array<{
    itemVariantId: string | null;
    uniqueStockUnitId: string | null;
    requiredQuantity: number;
  }>,
): Promise<number> {
  const availability = [] as Array<{ requiredQuantity: number; availableQuantity: number }>;
  for (const component of components) {
    if (component.uniqueStockUnitId) {
      const [unit, held] = await Promise.all([
        db.uniqueStockUnit.findFirst({
          where: { id: component.uniqueStockUnitId, status: "IN_STOCK" },
          select: { id: true },
        }),
        db.inventoryReservation.count({
          where: { uniqueStockUnitId: component.uniqueStockUnitId, status: "RESERVED" },
        }),
      ]);
      availability.push({ requiredQuantity: 1, availableQuantity: unit && !held ? 1 : 0 });
    } else {
      const variantId = component.itemVariantId!;
      const [balances, held] = await Promise.all([
        db.inventoryCostBalance.findMany({
          where: { itemVariantId: variantId, businessUnitId },
          select: { trackingMode: true, quantity: true },
        }),
        db.inventoryReservation.aggregate({
          where: { itemVariantId: variantId, status: "RESERVED", inventoryLotId: { not: null } },
          _sum: { quantity: true },
        }),
      ]);
      const quantity =
        balances
          .filter((row) => row.trackingMode === "QUANTITY")
          .reduce((s, row) => s + row.quantity, 0) - (held._sum.quantity ?? 0);
      availability.push({
        requiredQuantity: component.requiredQuantity,
        availableQuantity: Math.max(0, quantity),
      });
    }
  }
  return skuAvailability(availability);
}

export function tokyoLocalInput(date = new Date()): string {
  const tokyo = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return tokyo.toISOString().slice(0, 16);
}
