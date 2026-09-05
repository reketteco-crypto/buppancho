import { requireInventoryContext } from "@/lib/inventory/context";
import { SupplierForm } from "@/components/forms/phase1-master-forms";
import { updateSupplierAction } from "@/app/inventory/actions";

export default async function SuppliersPage() {
  const context = await requireInventoryContext();
  const rows = await context.db.counterparty.findMany({
    where: { workspaceId: context.workspaceId, type: "SUPPLIER" },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Master</p>
          <h1>仕入先</h1>
          <p className="muted">フェーズ1では円建ての仕入先を管理します。</p>
        </div>
      </header>
      <div className="two-column">
        <section className="card">
          <h2>新しい仕入先</h2>
          <SupplierForm />
        </section>
        <section className="card">
          <h2>登録済み</h2>
          <div className="stack">
            {rows.map((row) => (
              <form action={updateSupplierAction} className="supplier-row" key={row.id}>
                <input type="hidden" name="id" value={row.id} />
                <label className="field">
                  <span>名称</span>
                  <input name="name" defaultValue={row.name} required />
                </label>
                <label className="field">
                  <span>メモ</span>
                  <input name="memo" defaultValue={row.memo ?? ""} />
                </label>
                <label className="check">
                  <input type="checkbox" name="active" defaultChecked={row.active} />
                  有効
                </label>
                <button className="button secondary">保存</button>
              </form>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
