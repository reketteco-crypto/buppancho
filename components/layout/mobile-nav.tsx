"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BadgeJapaneseYen, Boxes, Home, MoreHorizontal, PlusCircle } from "lucide-react";

const items = [
  { label: "ホーム", href: "/", icon: Home },
  { label: "登録", href: "/register", icon: PlusCircle },
  { label: "商品・在庫", href: "/inventory", icon: Boxes },
  { label: "その他", href: "/settings", icon: MoreHorizontal },
] as const;

function isCurrentPath(pathname: string, href: (typeof items)[number]["href"]): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/register") {
    return (
      pathname === "/register" ||
      pathname.startsWith("/purchases/new") ||
      pathname.startsWith("/inventory/operations/new")
    );
  }
  if (href === "/inventory") {
    return (
      (pathname.startsWith("/inventory") && !pathname.startsWith("/inventory/operations/new")) ||
      (pathname.startsWith("/purchases") && !pathname.startsWith("/purchases/new"))
    );
  }
  return pathname.startsWith(href);
}

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="mobile-nav" aria-label="モバイルナビゲーション">
      {items.slice(0, 3).map(({ label, href, icon: Icon }) => {
        const current = isCurrentPath(pathname, href);
        return (
          <Link
            className={current ? "current" : undefined}
            href={href}
            aria-current={current ? "page" : undefined}
            key={href}
          >
            <Icon size={20} />
            {label}
          </Link>
        );
      })}
      <span className="disabled" aria-disabled="true">
        <BadgeJapaneseYen size={20} />
        販売
      </span>
      {items.slice(3).map(({ label, href, icon: Icon }) => {
        const current = isCurrentPath(pathname, href);
        return (
          <Link
            className={current ? "current" : undefined}
            href={href}
            aria-current={current ? "page" : undefined}
            key={href}
          >
            <Icon size={20} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
