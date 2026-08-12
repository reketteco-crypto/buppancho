import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { LoginForm } from "@/components/forms/login-form";

export const metadata = { title: "ログイン" };

export default async function LoginPage() {
  const session = await getCurrentSession();
  if (session) redirect(session.userAccount.workspace.setupCompletedAt ? "/" : "/setup");
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-mark" style={{ marginBottom: 22 }}>
          物
        </div>
        <p className="eyebrow">Buppancho</p>
        <h1>物販帳</h1>
        <p className="muted" style={{ marginBottom: 28 }}>
          物販の記録を、迷わず確かに。
        </p>
        <LoginForm />
      </section>
    </main>
  );
}
