"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { BuyInput } from "@/lib/commerce/input";
import type { PurchaseChoice, PurchaseChoices } from "@/lib/commerce/purchase-choice";
import { useClientReady } from "@/lib/use-client-ready";

export function PurchaseProductPicker({
  context,
  date,
  mode,
  selectedId,
  onSelect,
}: {
  context: BuyInput["context"];
  date: string;
  mode: "QUANTITY" | "UNIQUE";
  selectedId: string;
  onSelect: (choice: PurchaseChoice) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const ready = useClientReady();
  const panelId = useId();
  const [open, setOpen] = useState(false),
    [q, setQ] = useState(""),
    [tab, setTab] = useState<"products" | "history">("products"),
    [page, setPage] = useState(1),
    [retry, setRetry] = useState(0),
    [result, setResult] = useState<{ key: string; data?: PurchaseChoices; error?: string }>(),
    [note, setNote] = useState<{ id: string; text: string }>();
  const key = JSON.stringify({ context, date, mode, q, tab, page, retry });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/commerce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            action: "purchase-choices",
            kind: "BUY",
            payload: JSON.parse(key),
          }),
        });
        const body = (await response.json()) as { choices?: PurchaseChoices; error?: string };
        if (!response.ok || !body.choices) {
          if (!disposed)
            setResult({
              key,
              error:
                response.status < 500 && body.error
                  ? body.error
                  : "商品を取得できませんでした。再読み込みしてください。",
            });
          return;
        }
        if (!disposed) setResult({ key, data: body.choices });
      } catch {
        if (!disposed)
          setResult({
            key,
            error: "通信できませんでした。接続を確認して再読み込みしてください。",
          });
      }
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, key]);
  const current = result?.key === key ? result : undefined;
  return (
    <div className="commerce-product-selection">
      <details ref={details} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary aria-disabled={!ready} tabIndex={ready ? 0 : -1}>
          商品・履歴から選ぶ
        </summary>
        {open && (
          <div className="commerce-product-picker">
            <label className="field">
              商品名・コード・取引先を検索
              <input
                maxLength={120}
                type="search"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <div className="commerce-picker-tabs" role="tablist" aria-label="商品候補">
              {(
                [
                  ["products", "登録商品"],
                  ["history", "購入履歴"],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  role="tab"
                  id={`${panelId}-${value}`}
                  aria-controls={panelId}
                  aria-selected={tab === value}
                  tabIndex={tab === value ? 0 : -1}
                  key={value}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? "products"
                        : event.key === "End"
                          ? "history"
                          : tab === "products"
                            ? "history"
                            : "products";
                    setTab(next);
                    setPage(1);
                    document.getElementById(`${panelId}-${next}`)?.focus();
                  }}
                  onClick={() => {
                    setTab(value);
                    setPage(1);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`}>
              {!current && (
                <p className="commerce-caption" role="status">
                  検索中…
                </p>
              )}
              {current?.error && (
                <div role="alert">
                  <p className="error-message">{current.error}</p>
                  <button
                    type="button"
                    className="commerce-text-button"
                    onClick={() => setRetry((v) => v + 1)}
                  >
                    再読み込み
                  </button>
                </div>
              )}
              {current?.data && (
                <>
                  <div className="commerce-picker-pages">
                    <span>
                      {current.data.total}件 · {current.data.page} / {current.data.pages}ページ
                    </span>
                    <button
                      type="button"
                      className="commerce-text-button"
                      disabled={current.data.page <= 1}
                      onClick={() => setPage(current.data!.page - 1)}
                    >
                      前へ
                    </button>
                    <button
                      type="button"
                      className="commerce-text-button"
                      disabled={current.data.page >= current.data.pages}
                      onClick={() => setPage(current.data!.page + 1)}
                    >
                      次へ
                    </button>
                  </div>
                  {current.data.rows.map((choice) => (
                    <button
                      type="button"
                      className="commerce-product-choice"
                      key={choice.id}
                      aria-pressed={selectedId === choice.variantId}
                      onClick={() => {
                        onSelect(choice);
                        const weight = choice.measurements.weight;
                        setNote({
                          id: choice.variantId,
                          text: weight
                            ? `参照した重量 ${weight.value}g · ${weight.date} · ${weight.code}`
                            : "重量の履歴はありません。",
                        });
                        if (details.current) {
                          details.current.open = false;
                          details.current.querySelector("summary")?.focus();
                        }
                      }}
                    >
                      <strong>{choice.name}</strong>
                      <small>
                        {choice.code}
                        {choice.measurements.weight
                          ? ` · ${choice.measurements.weight.value}g · ${choice.measurements.weight.date} · ${choice.measurements.weight.code}`
                          : " · 重量未登録"}
                      </small>
                      {choice.measurements.volume && (
                        <small>
                          容積 {choice.measurements.volume.value}cm³ ·{" "}
                          {choice.measurements.volume.date} · {choice.measurements.volume.code}
                        </small>
                      )}
                      {choice.history && (
                        <small>
                          {choice.history.date} · {choice.history.supplier} · {choice.history.code}
                          <br />
                          {choice.history.name}
                          {choice.history.sourceName
                            ? ` · 取込名 ${choice.history.sourceName}`
                            : ""}
                          <br />
                          {choice.history.quantity}点 ·{" "}
                          {choice.history.priceBasis === "UNIT" ? "単価" : "明細金額"}{" "}
                          {choice.history.amount} {choice.history.currency}
                        </small>
                      )}
                    </button>
                  ))}
                  {!current.data.rows.length && (
                    <p className="commerce-caption">該当する商品はありません。</p>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </details>
      {note?.id === selectedId && (
        <p role="status" className="commerce-caption">
          {note.text}
        </p>
      )}
    </div>
  );
}
