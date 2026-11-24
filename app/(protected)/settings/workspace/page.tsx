import { MasterForm } from "@/components/forms/master-form";
import { updateWorkspaceAction } from "@/app/actions";
import { requireSession } from "@/lib/auth/session";

export default async function WorkspacePage() {
  const session = await requireSession();
  const workspace = session.userAccount.workspace;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>ワークスペース</h1>
        </div>
      </header>
      <section className="card">
        <MasterForm action={updateWorkspaceAction} className="stack">
          <input type="hidden" name="revision" value={workspace.revision} />
          <label className="field">
            <span>表示名</span>
            <input name="name" defaultValue={workspace.name} required maxLength={100} />
          </label>
          <label className="field">
            <span>タイムゾーン</span>
            <input value={workspace.timezone} readOnly />
          </label>
          <label className="field">
            <span>基本通貨</span>
            <input value={workspace.baseCurrency} readOnly />
          </label>
          <p className="muted">
            フェーズ0では日本国内運用を前提とし、タイムゾーンと通貨は変更できません。
          </p>
          <button className="button" type="submit">
            名称を保存
          </button>
        </MasterForm>
      </section>
    </div>
  );
}
