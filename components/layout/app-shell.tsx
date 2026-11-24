import Link from "next/link";
import { Home, ShoppingBag, Boxes, BadgeJapaneseYen, Wallet, Settings, LogOut } from "lucide-react";
import { logoutAction } from "@/app/actions";
import { OnlineStatus } from "@/components/online-status";
import { ContextSelector } from "@/components/layout/context-selector";
import { MobileNav } from "@/components/layout/mobile-nav";
import { NavLink } from "./nav-link";

type ShellProps = {
  children: React.ReactNode;
  workspaceName: string;
  operators: Array<{ id: string; displayName: string }>;
  assignments: Array<{
    year: number;
    reportingEntityName?: string;
    businessUnit: { id: string; name: string; color: string };
    defaultOperatorId: string | null;
  }>;
  activeOperatorId: string | null;
  activeBusinessUnitId: string | null;
  selectedYear: number | null;
};

const activeItems = [
  { label: "購入", icon: ShoppingBag, href: "/purchases" },
  { label: "商品", icon: Boxes, href: "/products" },
  { label: "販売", icon: BadgeJapaneseYen, href: "/sales" },
  { label: "お金", icon: Wallet, href: "/money" },
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
          <NavLink href="/">
            <Home size={19} />
            ホーム
          </NavLink>
          {activeItems.map(({ label, icon: Icon, href }) => (
            <NavLink key={label} href={href}>
              <Icon size={19} />
              {label}
            </NavLink>
          ))}
          <NavLink href="/settings">
            <Settings size={19} />
            設定
          </NavLink>
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
          <Link href="/settings" className="header-settings" aria-label="設定">
            <Settings size={19} />
          </Link>
          <Link href="/register" className="button secondary">
            ＋記録
          </Link>
        </header>
        {props.children}
      </main>
      <MobileNav />
    </div>
  );
}
