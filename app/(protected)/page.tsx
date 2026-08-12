import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Users,
  Building2,
  CalendarRange,
  ShieldCheck,
  DatabaseBackup,
  ArrowUpRight,
} from "lucide-react";
import { requireSession } from "@/lib/auth/session";

const cards = [
  { href: "/settings/operators", title: "入力者", text: "記録を行う担当者を管理", icon: Users },
  {
    href: "/settings/business-units",
    title: "販売部門",
    text: "中国輸入・アパレルの活動単位",
    icon: Building2,
  },
  {
    href: "/settings/fiscal-years",
    title: "会計年度",
    text: "申告方式と年度別の帰属",
    icon: CalendarRange,
  },
  {
    href: "/settings/security",
    title: "セキュリティ",
    text: "パスワードとセッション",
    icon: ShieldCheck,
  },
  {
    href: "/settings/backup",
    title: "バックアップ",
    text: "取得状態と復元手順",
    icon: DatabaseBackup,
  },
];

export default async function HomePage() {
  const session = await requireSession();
  if (!session.userAccount.workspace.setupCompletedAt) redirect("/setup");
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Phase 0 / Foundation</p>
          <h1>基盤の状態</h1>
          <p className="muted">入力者・販売部門・年度を確認してから記録を始めます。</p>
        </div>
        <span className="status-chip">初期設定済み</span>
      </header>
      <section className="card" style={{ marginBottom: 20 }}>
        <p className="eyebrow">現在のコンテキスト</p>
        <div className="card-grid">
          <div>
            <strong>入力者</strong>
            <p className="muted">{session.activeOperator?.displayName ?? "未選択"}</p>
          </div>
          <div>
            <strong>販売部門</strong>
            <p className="muted">{session.activeBusinessUnit?.name ?? "未選択"}</p>
          </div>
          <div>
            <strong>対象年度</strong>
            <p className="muted">{session.selectedYear ? `${session.selectedYear}年` : "未選択"}</p>
          </div>
        </div>
      </section>
      <div className="card-grid">
        {cards.map(({ href, title, text, icon: Icon }) => (
          <Link className="card card-link" href={href} key={href}>
            <div className="card-icon">
              <Icon size={21} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div>
                <h2>{title}</h2>
                <p className="muted" style={{ marginBottom: 0 }}>
                  {text}
                </p>
              </div>
              <ArrowUpRight size={18} />
            </div>
          </Link>
        ))}
      </div>
      <p className="notice" style={{ marginTop: 24 }}>
        商品・仕入れ・在庫・販売・会計機能はフェーズ1以降です。この画面では未実装値を表示しません。
      </p>
    </div>
  );
}
