import { MasterForm } from "@/components/forms/master-form";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createReportingEntityAction, updateReportingEntityAction } from "@/app/actions";

export default async function ReportingEntitiesPage() {
  const session = await requireSession();
  const rows = await getDb().reportingEntity.findMany({
    where: { workspaceId: session.userAccount.workspaceId },
    include: { _count: { select: { fiscalYearProfiles: true } } },
    orderBy: { createdAt: "asc" },
  });
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Reporting entities</p>
          <h1>申告主体</h1>
          <p className="muted">所得と帳簿が帰属する人を、入力者や販売部門から分離します。</p>
        </div>
      </header>
      <MasterForm
        action={createReportingEntityAction}
        className="card context-form"
        style={{ marginBottom: 20 }}
      >
        <label className="field">
          <span>新しい申告主体の名称</span>
          <input name="displayName" maxLength={50} required />
        </label>
        <button className="button">申告主体を追加</button>
      </MasterForm>
      <div className="stack">
        {rows.map((row) => (
          <MasterForm action={updateReportingEntityAction} className="card" key={row.id}>
            <input type="hidden" name="revision" value={row.revision} />
            <input type="hidden" name="id" value={row.id} />
            <div className="context-form">
              <label className="field">
                <span>名称</span>
                <input name="displayName" defaultValue={row.displayName} />
              </label>
              <div className="field">
                <span>種別</span>
                <strong>個人</strong>
              </div>
              <label className="field">
                <span>状態</span>
                <span>
                  <input
                    style={{ width: "auto", minHeight: 0 }}
                    type="checkbox"
                    name="active"
                    defaultChecked={row.active}
                  />{" "}
                  有効
                </span>
              </label>
              <button className="button secondary">保存</button>
            </div>
            <p className="muted">設定済み年度: {row._count.fiscalYearProfiles}件</p>
          </MasterForm>
        ))}
      </div>
    </div>
  );
}
