import Link from "next/link";
import {
  Settings,
  Users,
  Contact,
  Building2,
  CalendarRange,
  ShieldCheck,
  DatabaseBackup,
  MapPin,
  Truck,
  LogOut,
} from "lucide-react";
import { logoutAction } from "@/app/actions";

const items = [
  ["/settings/storage-locations", "保管場所", "倉庫・棚・収納場所", MapPin],
  ["/settings/suppliers", "仕入先", "国内仕入れ先", Truck],
  ["/settings/workspace", "ワークスペース", "名称と基本情報", Settings],
  ["/settings/operators", "入力者", "記録を行う担当者", Users],
  ["/settings/reporting-entities", "申告主体", "所得・帳簿の帰属先", Contact],
  ["/settings/business-units", "販売部門", "物販活動の管理単位", Building2],
  ["/settings/fiscal-years", "会計年度", "申告方式と年度別割当", CalendarRange],
  ["/settings/security", "セキュリティ", "パスワードとセッション", ShieldCheck],
  ["/settings/backup", "バックアップ", "取得状態と復元手順", DatabaseBackup],
] as const;

export default function SettingsPage() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>その他・設定</h1>
          <p className="muted">物販帳の基盤設定を管理します。</p>
        </div>
      </header>
      <div className="card-grid">
        {items.map(([href, title, text, Icon]) => (
          <Link key={href} className="card card-link" href={href}>
            <div className="card-icon">
              <Icon size={21} />
            </div>
            <h2>{title}</h2>
            <p className="muted" style={{ marginBottom: 0 }}>
              {text}
            </p>
          </Link>
        ))}
      </div>
      <section className="card account-card" aria-labelledby="account-heading">
        <div>
          <p className="eyebrow">Account</p>
          <h2 id="account-heading">アカウント</h2>
          <p className="muted">
            この端末のセッションを終了します。登録済みのデータは削除されません。
          </p>
        </div>
        <form action={logoutAction}>
          <button className="button secondary" type="submit">
            <LogOut size={19} aria-hidden="true" />
            この端末からログアウト
          </button>
        </form>
      </section>
    </div>
  );
}
