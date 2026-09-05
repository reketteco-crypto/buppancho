import { InventoryOperationForm } from "@/components/forms/inventory-operation-form";
import { requireInventoryContext } from "@/lib/inventory/context";

export default async function InventoryOperationPage() {
  const context = await requireInventoryContext();
  const [variants, units, locations, balances] = await Promise.all([
    context.db.itemVariant.findMany({
      where: {
        active: true,
        inventoryItem: {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          status: "ACTIVE",
        },
      },
      include: { inventoryItem: true },
      orderBy: { inventoryItem: { name: "asc" } },
    }),
    context.db.uniqueStockUnit.findMany({
      where: {
        workspaceId: context.workspaceId,
        status: "IN_STOCK",
        itemVariant: { inventoryItem: { businessUnitId: context.businessUnitId } },
      },
      include: { itemVariant: { include: { inventoryItem: true } }, storageLocation: true },
      orderBy: { individualCode: "asc" },
    }),
    context.db.storageLocation.findMany({
      where: {
        workspaceId: context.workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
      },
      orderBy: { code: "asc" },
    }),
    context.db.inventoryCostBalance.findMany({
      where: { businessUnitId: context.businessUnitId, quantity: { gt: 0 } },
      select: { itemVariantId: true, trackingMode: true },
    }),
  ]);
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  return (
    <div className="page narrow-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Stock Movement</p>
          <h1>在庫移動・調整</h1>
          <p className="muted">確定後は移動履歴として残り、現在庫へ反映されます。</p>
        </div>
      </header>
      <section className="card">
        <InventoryOperationForm
          variants={variants.flatMap((variant) => {
            const actual = balances
              .filter((balance) => balance.itemVariantId === variant.id)
              .map((balance) => balance.trackingMode);
            const modes = [...new Set([variant.inventoryItem.managementType, ...actual])];
            return modes.map((trackingMode) => ({
              key: `${variant.id}:${trackingMode}`,
              id: variant.id,
              label: `${variant.inventoryItem.itemCode} ${variant.inventoryItem.name}（${trackingMode === "QUANTITY" ? "数量" : "個体"}）`,
              trackingMode,
            }));
          })}
          units={units.map((unit) => ({
            id: unit.id,
            variantId: unit.itemVariantId,
            label: `${unit.individualCode} ${unit.itemVariant.inventoryItem.name}（${unit.storageLocation.name}）`,
            locationId: unit.storageLocationId,
          }))}
          locations={locations}
          today={today}
        />
      </section>
    </div>
  );
}
