"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useClientReady } from "@/lib/use-client-ready";

export function CostEntry({ children }: { children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const focusObserver = useRef<MutationObserver | null>(null);
  const ready = useClientReady();
  useEffect(() => () => focusObserver.current?.disconnect(), []);
  return (
    <div className="commerce-cost-entry">
      <button
        type="button"
        disabled={!ready}
        className="button secondary"
        onClick={() => {
          if (!details.current) return;
          const root = details.current;
          root.open = true;
          focusObserver.current?.disconnect();
          const focusFile = () => {
            if (!root.open) {
              focusObserver.current?.disconnect();
              return true;
            }
            const importer = root.querySelector<HTMLDetailsElement>("[data-candidate-import]");
            const input = importer?.querySelector<HTMLInputElement>('input[type="file"]');
            if (
              !input ||
              input.matches(":disabled") ||
              importer?.querySelector("summary")?.getAttribute("aria-disabled") === "true"
            )
              return false;
            focusObserver.current?.disconnect();
            focusObserver.current = null;
            importer!.open = true;
            input.focus();
            return true;
          };
          // The child form can finish loading after the surrounding controls.
          if (!focusFile()) {
            focusObserver.current = new MutationObserver(focusFile);
            focusObserver.current.observe(root, {
              subtree: true,
              childList: true,
              attributes: true,
              attributeFilter: ["disabled", "aria-disabled", "open"],
            });
          }
        }}
      >
        ファイルから費用を追加
      </button>
      <details ref={details} className="commerce-disclosure">
        <summary aria-disabled={!ready} tabIndex={ready ? 0 : -1}>
          費用を追加
        </summary>
        {children}
      </details>
    </div>
  );
}
