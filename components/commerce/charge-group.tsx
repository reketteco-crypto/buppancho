"use client";

import { useId, type ReactNode } from "react";
import { X } from "lucide-react";

export function ChargeGroup({
  name,
  onRemove,
  children,
}: {
  name: string;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const title = name.trim() || "新しい費用";
  return (
    <section className="commerce-charge-group" role="group" aria-labelledby={id}>
      <div className="commerce-charge-heading">
        <h3 id={id}>{title}</h3>
        {onRemove && (
          <button
            type="button"
            className="commerce-text-button"
            aria-label={`${title}を削除`}
            onClick={onRemove}
          >
            <X size={16} aria-hidden="true" />
            削除
          </button>
        )}
      </div>
      {children}
    </section>
  );
}
