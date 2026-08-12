"use client";

import { useEffect } from "react";

export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Buppancho request failed", error.digest);
  }, [error]);
  return (
    <div className="page">
      <section className="card">
        <p className="eyebrow">Error</p>
        <h1>処理を完了できませんでした</h1>
        <p className="muted">
          入力内容と通信状態を確認してください。データベース停止中は更新を受け付けません。
        </p>
        <button className="button" onClick={reset}>
          再試行
        </button>
        {error.digest ? <p className="muted">問い合わせ番号: {error.digest}</p> : null}
      </section>
    </div>
  );
}
