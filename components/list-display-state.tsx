"use client";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";

const subscribe = () => () => {};
export function ListBackLink({
  context,
  href,
  children,
  className,
}: {
  context: string;
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const base = href.split("?")[0]!;
  const target = useSyncExternalStore(
    subscribe,
    () => {
      try {
        const saved = sessionStorage.getItem(`buppancho:list:last:${context}:${base}`);
        return saved === base || saved?.startsWith(`${base}?`) ? saved : href;
      } catch {
        return href;
      }
    },
    () => href,
  );
  return (
    <Link href={target} className={className} scroll={false}>
      {children}
    </Link>
  );
}

/** Display position only. Business input is restored from a server-side draft. */
export function ListDisplayState({ context }: { context: string }) {
  const path = usePathname();
  const query = useSearchParams().toString();
  useEffect(() => {
    const params = new URLSearchParams(query);
    params.sort();
    const key = `buppancho:list:${context}:${path}?${params}`;
    let y = window.scrollY,
      restoring = true,
      departed = false,
      frame = 0,
      restoreFrame = 0;
    const persist = () => {
      try {
        sessionStorage.setItem(key, String(y));
      } catch {}
    };
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(key);
      sessionStorage.setItem(
        `buppancho:list:last:${context}:${path}`,
        `${path}${query ? `?${query}` : ""}`,
      );
    } catch {
      /* Display state is optional when storage is unavailable. */
    }
    const position = stored === null ? null : Number(stored);
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = requestAnimationFrame(() => {
        if (position !== null && Number.isFinite(position) && position >= 0)
          window.scrollTo(0, position);
        y = window.scrollY;
        restoring = false;
      });
    });
    const scroll = () => {
      if (restoring || departed) return;
      y = window.scrollY;
      if (!frame)
        frame = requestAnimationFrame(() => {
          persist();
          frame = 0;
        });
    };
    const leaving = (event: Event) => {
      if (departed) return;
      if (!restoring) {
        y = window.scrollY;
        persist();
      }
      if (
        event instanceof MouseEvent &&
        event.button === 0 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.altKey
      ) {
        const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (link instanceof HTMLAnchorElement && link.target !== "_blank") {
          const next = new URL(link.href);
          if (
            next.origin === window.location.origin &&
            (next.pathname !== path || next.search !== window.location.search)
          )
            departed = true;
        }
      }
    };
    document.addEventListener("click", leaving, true);
    window.addEventListener("pagehide", leaving);
    window.addEventListener("scroll", scroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(restoreFrame);
      if (!restoring) persist();
      document.removeEventListener("click", leaving, true);
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("scroll", scroll);
    };
  }, [context, path, query]);
  return null;
}
