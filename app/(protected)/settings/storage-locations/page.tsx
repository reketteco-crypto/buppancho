import { MasterForm } from "@/components/forms/master-form";
import { SettingsBackLink } from "@/components/settings-back-link";
import { requireInventoryContext } from "@/lib/inventory/context";
import { StorageLocationForm } from "@/components/forms/phase1-master-forms";
import { updateStorageLocationAction } from "@/app/inventory/actions";

export default async function StorageLocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const context = await requireInventoryContext();
  const rows = await context.db.storageLocation.findMany({
    where: { workspaceId: context.workspaceId },
    include: { businessUnit: true },
    orderBy: [{ active: "desc" }, { code: "asc" }],
  });
  return (
    <div className="page">
      <SettingsBackLink returnTo={(await searchParams).returnTo} />
      <header className="page-header">
        <div>
          <p className="eyebrow">Master</p>
          <h1>保管場所</h1>
          <p className="muted">在庫が残る場所は無効化できません。</p>
        </div>
      </header>
      <div className="two-column">
        <section className="card">
          <h2>新しい保管場所</h2>
          <StorageLocationForm businessUnitId={context.businessUnitId} />
        </section>
        <section className="card">
          <h2>登録済み</h2>
          <div className="stack">
            {rows.map((row) => (
              <MasterForm action={updateStorageLocationAction} className="compact-row" key={row.id}>
                <input type="hidden" name="revision" value={row.revision} />
                <input type="hidden" name="id" value={row.id} />
                <div>
                  <strong>{row.code}</strong>
                  <small>{row.businessUnit?.name ?? "全部門共通"}</small>
                </div>
                <input name="name" defaultValue={row.name} required />
                <label className="check">
                  <input type="checkbox" name="active" defaultChecked={row.active} />
                  有効
                </label>
                <button className="button secondary">保存</button>
              </MasterForm>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
