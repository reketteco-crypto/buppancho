import Link from "next/link";
import { settingsReturnPath } from "@/lib/settings/return-path";

export function InputReturnLink({ returnTo }: { returnTo?: string }) {
  const safe = settingsReturnPath(returnTo);
  return safe ? (
    <p className="input-return">
      <Link href={safe}>← 保存した入力へ戻る</Link>
    </p>
  ) : null;
}
