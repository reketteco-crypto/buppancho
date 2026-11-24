"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { useClientReady } from "@/lib/use-client-ready";
import type { MoneyHistoryRow } from "@/lib/commerce/money-history-view";
import type { SkuInput } from "@/lib/commerce/input";
import { moneyReturnHref } from "@/lib/commerce/money-navigation";
import { MoneyEditor } from "./money-form";

export function MoneyHistory({
  rows,
  context,
  date,
  initialOpen,
  href,
  records,
}: {
  rows: MoneyHistoryRow[];
  context: SkuInput["context"];
  date: string;
  initialOpen: string;
  href: string;
  records: boolean;
}) {
  const hydrated = useClientReady();
  const [open, setOpen] = useState(initialOpen);
  const [pending, setPending] = useState(false);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const rowHref = (id: string) => {
    const url = new URL(href, "http://money.local");
    url.searchParams.set("open", id);
    return moneyReturnHref(url.pathname + url.search)!;
  };
  const toggle = (id: string) => {
    const next = open === id ? "" : id;
    setOpen(next);
    const url = new URL(href, "http://money.local");
    if (next) url.searchParams.set("open", next);
    else url.searchParams.delete("open");
    window.history.replaceState(null, "", url.pathname + url.search);
    if (!next) buttons.current.get(id)?.focus({ preventScroll: true });
  };
  return (
    <div className="money-history">
      <div className="money-history-columns" aria-hidden="true">
        <span>日付</span>
        <span>内容</span>
        <span>{records ? "決済状況（現在）" : "口座の動き"}</span>
        <span>金額</span>
        <span />
      </div>
      {rows.map((row) => (
        <div
          className={`money-history-item${row.status === "取消済み" ? " is-cancelled" : ""}`}
          key={row.id}
        >
          <button
            ref={(element) => {
              if (element) buttons.current.set(row.id, element);
              else buttons.current.delete(row.id);
            }}
            type="button"
            className="money-history-toggle"
            onClick={() => toggle(row.id)}
            disabled={pending || !hydrated}
            aria-expanded={open === row.id}
            aria-controls={`money-detail-${row.id}`}
          >
            <time className="money-history-date" dateTime={row.date}>
              {row.date.replaceAll("-", "/")}
            </time>
            <span className="money-history-content">
              <strong>{row.title}</strong>
              {(row.kindLabel !== row.title || row.reference || row.status === "取消済み") && (
                <small>
                  {[
                    row.kindLabel !== row.title ? row.kindLabel : "",
                    row.reference,
                    row.status === "取消済み" ? row.status : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              )}
            </span>
            <span className="money-history-flow">{row.flow}</span>
            <span className="money-history-amount">
              {row.amountLabel && <small>{row.amountLabel}</small>}
              <strong>{row.amount}</strong>
              {row.feeLabel && <small>{row.feeLabel}</small>}
            </span>
            <ChevronDown
              size={16}
              className={`money-history-chevron${open === row.id ? " is-open" : ""}`}
              aria-hidden="true"
            />
          </button>
          {open === row.id ? (
            <section
              className="money-history-detail"
              id={`money-detail-${row.id}`}
              aria-label={`${row.title}の詳細`}
            >
              {row.entries.map((entry) => (
                <div className="money-history-entry" key={entry.id}>
                  <span>
                    {entry.name}
                    {entry.label && <small> · {entry.label}</small>}
                  </span>
                  <strong>{entry.amount}</strong>
                </div>
              ))}
              {row.status && <p className="commerce-caption">{row.status}</p>}
              {row.memo && <p className="money-history-memo">{row.memo}</p>}
              <div className="money-history-detail-actions">
                {row.relatedHref && (
                  <Link
                    className="commerce-text-button"
                    href={
                      row.type === "record"
                        ? `${row.relatedHref}?returnTo=${encodeURIComponent(rowHref(row.id))}`
                        : row.relatedHref
                    }
                  >
                    {row.type === "record" ? "費用・収入の詳細" : "関連する取引"}
                  </Link>
                )}
                <button
                  type="button"
                  className="commerce-text-button"
                  disabled={pending}
                  onClick={() => toggle(row.id)}
                >
                  詳細を閉じる
                </button>
              </div>
              {row.canCancel && (
                <details className="money-history-cancel">
                  <summary>この入出金を取り消す</summary>
                  <MoneyEditor
                    onPendingChange={setPending}
                    accounts={[]}
                    returnTo={rowHref(row.id)}
                    initial={{
                      context,
                      idempotencyKey: row.id,
                      date,
                      kind: "REVERSAL",
                      amount: row.principal,
                      fee: row.fee,
                      accountId: "",
                      accountRevision: 0,
                      toAccountId: "",
                      toAccountRevision: 0,
                      reversesId: row.id,
                      memo: "",
                    }}
                  />
                </details>
              )}
            </section>
          ) : (
            <div id={`money-detail-${row.id}`} hidden />
          )}
        </div>
      ))}
      {!rows.length && (
        <p className="commerce-secondary">
          {records ? "費用・収入の記録はありません。" : "入出金の記録はありません。"}
        </p>
      )}
    </div>
  );
}
