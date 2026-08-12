export const metadata = { title: "オフライン" };
export default function OfflinePage() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-mark" style={{ marginBottom: 22 }}>
          物
        </div>
        <p className="eyebrow">Offline</p>
        <h1>通信を確認してください</h1>
        <p className="muted">
          物販帳の更新はオンライン時のみ行えます。通信が復旧してから、ブラウザーで画面を再読み込みしてください。
        </p>
      </section>
    </main>
  );
}
