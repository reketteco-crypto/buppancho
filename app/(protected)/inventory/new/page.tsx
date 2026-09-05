import Link from "next/link";
import { InventoryItemForm } from "@/components/forms/inventory-item-form";
import { requireInventoryContext } from "@/lib/inventory/context";

export default async function NewInventoryItemPage() {
  const context = await requireInventoryContext();
  const locations = await context.db.storageLocation.findMany({
    where: {
      workspaceId: context.workspaceId,
      active: true,
      OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
    },
    orderBy: { code: "asc" },
  });
  return (
    <div className="page narrow-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Product</p>
          <h1>商品登録</h1>
          <p className="muted">コードを空欄にするとITEM形式で自動採番します。</p>
        </div>
        <Link className="button secondary" href="/inventory">
          一覧へ戻る
        </Link>
      </header>
      <section className="card">
        <InventoryItemForm locations={locations} />
      </section>
    </div>
  );
}
