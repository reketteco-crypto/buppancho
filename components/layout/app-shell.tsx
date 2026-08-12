import Link from "next/link";
import {
  Home,
  PlusCircle,
  Boxes,
  BadgeJapaneseYen,
  MoreHorizontal,
  Settings,
  LogOut,
} from "lucide-react";
import { logoutAction } from "@/app/actions";
import { OnlineStatus } from "@/components/online-status";
import { ContextSelector } from "@/components/layout/context-selector";

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

const futureItems = [
  { label: "登録", icon: PlusCircle, phase: "F1" },
  { label: "商品・在庫", icon: Boxes, phase: "F1" },
  { label: "販売", icon: BadgeJapaneseYen, phase: "F2" },
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
          {futureItems.map(({ label, icon: Icon, phase }) => (
            <span className="nav-link disabled" key={label} aria-disabled="true">
              <Icon size={19} />
              {label}
              <span className="phase-badge">{phase}</span>
            </span>
          ))}
          <Link className="nav-link" href="/settings">
            <Settings size={19} />
            その他・設定
          </Link>
        </nav>
        <form action={logoutAction} style={{ marginTop: "auto" }}>
          <button
            className="nav-link"
            style={{ width: "100%", background: "transparent", border: 0 }}
          >
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
      <nav className="mobile-nav" aria-label="モバイルナビゲーション">
        <Link href="/">
          <Home size={20} />
          ホーム
        </Link>
        <span className="disabled">
          <PlusCircle size={20} />
          登録
        </span>
        <span className="disabled">
          <Boxes size={20} />
          商品・在庫
        </span>
        <span className="disabled">
          <BadgeJapaneseYen size={20} />
          販売
        </span>
        <Link href="/settings">
          <MoreHorizontal size={20} />
          その他
        </Link>
      </nav>
    </div>
  );
}
