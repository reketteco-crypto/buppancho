import Link from "next/link";
import { settingsReturnPath } from "@/lib/settings/return-path";
export function SettingsBackLink({ returnTo }: { returnTo?: string }) {
  const path = settingsReturnPath(returnTo);
  return path ? (
    <p className="notice">
      <Link href={path}>保存した入力へ戻る</Link>（設定の保存だけでは出品・入庫を確定しません）
    </p>
  ) : null;
}
