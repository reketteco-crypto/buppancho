"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const current =
    href === "/"
      ? pathname === "/"
      : href === "/products"
        ? pathname.startsWith("/products") ||
          pathname.startsWith("/inventory") ||
          pathname.startsWith("/sales/skus")
        : href === "/sales"
          ? pathname.startsWith("/sales") && !pathname.startsWith("/sales/skus")
          : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link className="nav-link" href={href} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}
