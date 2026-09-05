import { PurchaseForm } from "@/components/forms/purchase-form";
import { requireInventoryContext } from "@/lib/inventory/context";

export default async function NewPurchasePage() {
  const context = await requireInventoryContext();
  const [suppliers, locations, variants] = await Promise.all([
    context.db.counterparty.findMany({
      where: { workspaceId: context.workspaceId, type: "SUPPLIER", active: true },
      orderBy: { name: "asc" },
    }),
    context.db.storageLocation.findMany({
      where: {
        workspaceId: context.workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
      },
      orderBy: { code: "asc" },
    }),
    context.db.itemVariant.findMany({
      where: {
        workspaceId: context.workspaceId,
        active: true,
        inventoryItem: { businessUnitId: context.businessUnitId, status: "ACTIVE" },
      },
      include: { inventoryItem: true },
      orderBy: { inventoryItem: { name: "asc" } },
    }),
  ]);
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Purchase</p>
          <h1>仕入れ登録</h1>
          <p className="muted">
            新品の数量商品と中古の一点物を、同じ仕入れにまとめて登録できます。
          </p>
        </div>
      </header>
      <PurchaseForm
        suppliers={suppliers.map((row) => ({ id: row.id, label: row.name }))}
        locations={locations.map((row) => ({ id: row.id, label: `${row.code} ${row.name}` }))}
        variants={variants.map((row) => ({
          id: row.id,
          label: `${row.inventoryItem.itemCode} ${row.inventoryItem.name} / ${row.variantCode}`,
        }))}
        today={today}
      />
    </div>
  );
}
