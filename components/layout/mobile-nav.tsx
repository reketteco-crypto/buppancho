"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BadgeJapaneseYen, Boxes, Home, Wallet, ShoppingBag } from "lucide-react";

const items = [
  { label: "ホーム", href: "/", icon: Home },
  { label: "購入", href: "/purchases", icon: ShoppingBag },
  { label: "商品", href: "/products", icon: Boxes },
  { label: "販売", href: "/sales", icon: BadgeJapaneseYen },
  { label: "お金", href: "/money", icon: Wallet },
] as const;

function isCurrentPath(pathname: string, href: (typeof items)[number]["href"]): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/products") {
    return (
      pathname.startsWith("/products") ||
      pathname.startsWith("/inventory") ||
      pathname.startsWith("/sales/skus")
    );
  }
  if (href === "/sales")
    return pathname.startsWith("/sales") && !pathname.startsWith("/sales/skus");
  return pathname.startsWith(href);
}

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="mobile-nav" aria-label="モバイルナビゲーション">
      {items.slice(0, 4).map(({ label, href, icon: Icon }) => {
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
      {items.slice(4).map(({ label, href, icon: Icon }) => {
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
