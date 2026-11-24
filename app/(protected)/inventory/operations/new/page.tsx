import {
  InventoryOperationForm,
  type InventoryRecordInput,
} from "@/components/forms/inventory-operation-form";
import { requireInventoryContext } from "@/lib/inventory/context";
import Link from "next/link";
import { inputContext, recoveryRequest } from "@/lib/sales/workflow-view";

export default async function InventoryOperationPage({
  searchParams,
}: {
  searchParams: Promise<{ operation?: string }>;
}) {
  const context = await requireInventoryContext();
  const request = await recoveryRequest(context, (await searchParams).operation, "INVENTORY");
  const version = await context.db.inventoryRevision.findUnique({
    where: { businessUnitId: context.businessUnitId },
  });
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
        status: { in: ["IN_STOCK", "RESERVED"] },
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
      <Link className="button secondary" href="/inventory/stocktake/new">
        数えた数量を確認・訂正する
      </Link>
      <header className="page-header">
        <div>
          <p className="eyebrow">在庫の記録</p>
          <h1>在庫移動・調整</h1>
          <p className="muted">確定後は移動履歴として残り、現在庫へ反映されます。</p>
        </div>
      </header>
      <section className="card">
        <InventoryOperationForm
          context={inputContext(context)}
          inventoryRevision={(version?.revision ?? 0n).toString()}
          initial={request?.payload as InventoryRecordInput | undefined}
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
