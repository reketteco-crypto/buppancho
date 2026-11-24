import { MasterForm } from "@/components/forms/master-form";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createOperatorAction, updateOperatorAction } from "@/app/actions";

export default async function OperatorsPage() {
  const session = await requireSession();
  const rows = await getDb().operator.findMany({
    where: { workspaceId: session.userAccount.workspaceId },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { defaultAssignments: true } } },
  });
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Operators</p>
          <h1>入力者</h1>
          <p className="muted">
            誰が入力したかを記録する主体です。ログインアカウントとは別に管理します。
          </p>
        </div>
      </header>
      <MasterForm
        action={createOperatorAction}
        className="card context-form"
        style={{ marginBottom: 20 }}
      >
        <label className="field">
          <span>新しい入力者の表示名</span>
          <input name="displayName" maxLength={50} required />
        </label>
        <button className="button">入力者を追加</button>
      </MasterForm>
      <div className="stack">
        {rows.map((row) => (
          <MasterForm action={updateOperatorAction} className="card" key={row.id}>
            <input type="hidden" name="revision" value={row.revision} />
            <input type="hidden" name="id" value={row.id} />
            <div className="context-form">
              <label className="field">
                <span>表示名</span>
                <input name="displayName" defaultValue={row.displayName} />
              </label>
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
              <div className="field">
                <span>既定の部門数</span>
                <strong>{row._count.defaultAssignments}</strong>
              </div>
              <button className="button secondary">保存</button>
            </div>
          </MasterForm>
        ))}
      </div>
      <p className="notice" style={{ marginTop: 20 }}>
        履歴の参照性を守るため物理削除しません。使用しない入力者は無効化します。
      </p>
    </div>
  );
}
