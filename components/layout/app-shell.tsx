import Link from "next/link";
import { Home, PlusCircle, Boxes, BadgeJapaneseYen, Settings, LogOut } from "lucide-react";
import { logoutAction } from "@/app/actions";
import { OnlineStatus } from "@/components/online-status";
import { ContextSelector } from "@/components/layout/context-selector";
import { MobileNav } from "@/components/layout/mobile-nav";

type ShellProps = {
  children: React.ReactNode;
  workspaceName: string;
  operators: Array<{ id: string; displayName: string }>;
  assignments: Array<{
    year: number;
    businessUnit: { id: string; name: string; color: string };
    defaultOperatorId: string | null;
  }>;
  activeOperatorId: string | null;
  activeBusinessUnitId: string | null;
  selectedYear: number | null;
};

const activeItems = [
  { label: "登録", icon: PlusCircle, href: "/register" },
  { label: "商品・在庫", icon: Boxes, href: "/inventory" },
];

export function AppShell(props: ShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">物</span>
          <span>{props.workspaceName}</span>
        </div>
        <nav aria-label="メインナビゲーション">
          <Link className="nav-link" href="/">
            <Home size={19} />
            ホーム
          </Link>
          {activeItems.map(({ label, icon: Icon, href }) => (
            <Link className="nav-link" key={label} href={href}>
              <Icon size={19} />
              {label}
            </Link>
          ))}
          <span className="nav-link disabled" aria-disabled="true">
            <BadgeJapaneseYen size={19} />
            販売<span className="phase-badge">F2</span>
          </span>
          <Link className="nav-link" href="/settings">
            <Settings size={19} />
            その他・設定
          </Link>
        </nav>
        <form action={logoutAction} style={{ marginTop: "auto" }}>
          <button className="nav-link nav-logout" type="submit">
            <LogOut size={19} />
            ログアウト
          </button>
        </form>
      </aside>
      <main className="shell-main">
        <header className="context-bar">
          {props.operators.length && props.assignments.length ? (
            <ContextSelector
              operators={props.operators}
              assignments={props.assignments}
              activeOperatorId={props.activeOperatorId}
              activeBusinessUnitId={props.activeBusinessUnitId}
              selectedYear={props.selectedYear}
            />
          ) : (
            <span className="muted">初期設定を完了すると入力者と販売部門を選べます。</span>
          )}
          <OnlineStatus />
        </header>
        {props.children}
      </main>
      <MobileNav />
    </div>
  );
}
