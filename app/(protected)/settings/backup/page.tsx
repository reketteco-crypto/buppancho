import { readFile } from "node:fs/promises";
import { getServerEnv } from "@/lib/env";

type BackupStatus = {
  status?: "success" | "failure";
  finishedAt?: string;
  file?: string;
  message?: string;
  mirror?: string;
};

async function readStatus(): Promise<BackupStatus | null> {
  try {
    return JSON.parse(await readFile(getServerEnv().BACKUP_STATUS_FILE, "utf8")) as BackupStatus;
  } catch {
    return null;
  }
}

export default async function BackupPage() {
  const status = await readStatus();
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Backup</p>
          <h1>バックアップ</h1>
          <p className="muted">
            DB停止時にも失敗を確認できるよう、状態はDB外のファイルから読み取ります。
          </p>
        </div>
        <span className="status-chip">
          {status?.status === "success"
            ? "最終実行 成功"
            : status?.status === "failure"
              ? "最終実行 失敗"
              : "未実行"}
        </span>
      </header>
      <section className="card">
        <dl className="card-grid">
          <div>
            <dt className="muted">完了日時</dt>
            <dd>
              {status?.finishedAt
                ? new Date(status.finishedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
                : "記録なし"}
            </dd>
          </div>
          <div>
            <dt className="muted">ファイル</dt>
            <dd>{status?.file ?? "記録なし"}</dd>
          </div>
          <div>
            <dt className="muted">別保存先</dt>
            <dd>{status?.mirror || "未設定"}</dd>
          </div>
        </dl>
        {status?.message ? (
          <p className={status.status === "failure" ? "message error" : "message success"}>
            {status.message}
          </p>
        ) : null}
      </section>
      <p className="notice" style={{ marginTop: 20 }}>
        復元は誤上書きを防ぐため画面から実行しません。管理者が検証用の空DBを指定して復元スクリプトを実行します。手順は{" "}
        <code>docs/backup-restore.md</code> を参照してください。
      </p>
    </div>
  );
}
