"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ja">
      <body>
        <main className="auth-page">
          <section className="auth-card">
            <p className="eyebrow">System error</p>
            <h1>物販帳を表示できません</h1>
            <p className="muted">
              しばらく待ってから再試行してください。データベースが停止している場合、書き込みは行われません。
            </p>
            <button className="button" onClick={reset}>
              再試行
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
