import type { StockChoice } from "@/components/commerce/sku-form";
import { commerceOptions, type commerceContext } from "./view";
export async function stockChoices(c: Awaited<ReturnType<typeof commerceContext>>) {
  const options = await commerceOptions(c);
  const units = await c.db.uniqueStockUnit.findMany({
    where: {
      workspaceId: c.workspaceId,
      itemVariant: { inventoryItem: { businessUnitId: c.businessUnitId } },
    },
    include: { itemVariant: { include: { inventoryItem: true } } },
    orderBy: { individualCode: "asc" },
  });
  const products: StockChoice[] = [
    ...options.products
      .filter((p) => p.mode === "QUANTITY")
      .map((p) => ({
        id: p.id,
        variantId: p.id,
        unitId: null,
        name: p.name,
        label: `${p.name} · ${p.code}`,
        quantity: p.quantity,
      })),
    ...units.map((u) => ({
      id: u.id,
      variantId: null,
      unitId: u.id,
      name: u.itemVariant.inventoryItem.name,
      label: `${u.itemVariant.inventoryItem.name} · ${u.individualCode}`,
      quantity: u.status === "IN_STOCK" ? 1 : 0,
    })),
  ];
  return { ...options, choices: products };
}
