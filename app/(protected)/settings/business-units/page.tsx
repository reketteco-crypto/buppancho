import { MasterForm } from "@/components/forms/master-form";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createBusinessUnitAction, updateBusinessUnitAction } from "@/app/actions";

export default async function BusinessUnitsPage() {
  const session = await requireSession();
  const db = getDb();
  const rows = await db.businessUnit.findMany({
    where: { workspaceId: session.userAccount.workspaceId },
    include: { _count: { select: { assignments: true } } },
    orderBy: { createdAt: "asc" },
  });
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Business units</p>
          <h1>販売部門</h1>
          <p className="muted">管理上の物販活動と、年度ごとの申告主体を分離して管理します。</p>
        </div>
      </header>
      <MasterForm
        action={createBusinessUnitAction}
        className="card stack"
        style={{ marginBottom: 20 }}
      >
        <h2>販売部門を追加</h2>
        <div className="context-form">
          <label className="field">
            <span>部門コード</span>
            <input name="code" pattern="[A-Z0-9_]+" maxLength={40} required />
          </label>
          <label className="field">
            <span>名称</span>
            <input name="name" maxLength={80} required />
          </label>
          <label className="field">
            <span>表示色</span>
            <input type="color" name="color" defaultValue="#176b52" required />
          </label>
          <button className="button">追加</button>
        </div>
        <p className="muted">
          部門コードは保存後に変更できません。年度別の入力者と申告主体は会計年度画面で設定します。
        </p>
      </MasterForm>
      <div className="stack">
        {rows.map((row) => (
          <MasterForm action={updateBusinessUnitAction} className="card" key={row.id}>
            <input type="hidden" name="revision" value={row.revision} />
            <input type="hidden" name="id" value={row.id} />
            <p className="eyebrow">{row.code}</p>
            <div className="context-form">
              <label className="field">
                <span>名称</span>
                <input name="name" defaultValue={row.name} />
              </label>
              <label className="field">
                <span>表示色</span>
                <input type="color" name="color" defaultValue={row.color} />
              </label>
              <div className="field">
                <span>部門コード</span>
                <strong>{row.code}</strong>
              </div>
              <button className="button secondary">保存</button>
            </div>
            <label>
              <input
                style={{ width: "auto", minHeight: 0 }}
                type="checkbox"
                name="active"
                defaultChecked={row.active}
              />{" "}
              有効
            </label>
            <p className="muted">年度割当: {row._count.assignments}件</p>
          </MasterForm>
        ))}
      </div>
    </div>
  );
}
