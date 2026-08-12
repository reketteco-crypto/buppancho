import { revokeOtherSessionsAction } from "@/app/actions";
import { PasswordForm } from "@/components/forms/password-form";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";

export default async function SecurityPage() {
  const session = await requireSession();
  const sessions = await getDb().authSession.findMany({
    where: {
      userAccountId: session.userAccountId,
      revokedAt: null,
      absoluteExpiresAt: { gt: new Date() },
    },
    orderBy: { lastSeenAt: "desc" },
  });
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Security</p>
          <h1>セキュリティ</h1>
          <p className="muted">共通ログインのパスワードと有効なセッションを管理します。</p>
        </div>
      </header>
      <div className="setup-grid">
        <section className="card">
          <h2>パスワード変更</h2>
          <PasswordForm />
        </section>
        <section className="card">
          <h2>有効なセッション</h2>
          <p className="muted">現在を含めて{sessions.length}件</p>
          <ul>
            {sessions.map((item) => (
              <li key={item.id}>
                {item.id === session.id ? "現在のセッション" : "別のセッション"} — 最終利用{" "}
                {item.lastSeenAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
              </li>
            ))}
          </ul>
          <form action={revokeOtherSessionsAction}>
            <button className="button secondary">現在以外をログアウト</button>
          </form>
        </section>
      </div>
      <p className="notice" style={{ marginTop: 20 }}>
        共通アカウントでは、実際の操作者は画面で選択した入力者に基づく自己申告です。入力前に画面上部を確認してください。
      </p>
    </div>
  );
}
