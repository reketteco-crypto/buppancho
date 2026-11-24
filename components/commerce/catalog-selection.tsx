"use client";
import Link from "next/link";
import { withInputReturn } from "@/lib/settings/return-path";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CatalogStock } from "@/lib/commerce/catalog";
import type { SkuInput } from "@/lib/commerce/input";
import { MutationFeedback, useCommerceMutation } from "./mutation";
const signal = "buppancho:catalog-selection";
const subscribe = (callback: () => void) => {
  window.addEventListener(signal, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(signal, callback);
    window.removeEventListener("storage", callback);
  };
};
function read(key: string) {
  try {
    return sessionStorage.getItem(key) ?? "[]";
  } catch {
    return "[]";
  }
}
function write(key: string, ids: string[]) {
  try {
    sessionStorage.setItem(key, JSON.stringify(ids));
  } catch {}
  window.dispatchEvent(new Event(signal));
}
export function ProductTabs({
  scope,
  tab,
  returnTo,
}: {
  scope: string;
  tab: string;
  returnTo?: string;
}) {
  useEffect(() => {
    try {
      const key = `buppancho:catalog-tab:${scope}`,
        previous = sessionStorage.getItem(key);
      if (previous && previous !== tab) write(`buppancho:catalog:${scope}`, []);
      sessionStorage.setItem(key, tab);
    } catch {}
  }, [scope, tab]);
  return (
    <nav className="commerce-tabs" aria-label="商品表示">
      {[
        ["inventory", "在庫商品"],
        ["skus", "販売商品"],
        ["supplies", "資材・備品"],
      ].map(([value, label]) => (
        <Link
          key={value}
          href={withInputReturn(
            value === "inventory" ? "/products" : `/products?tab=${value}`,
            returnTo,
          )}
          aria-current={tab === value ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
export function BatchSkuEditor({
  context,
  date,
  products,
  scope,
}: {
  context: SkuInput["context"];
  date: string;
  products: CatalogStock[];
  scope: string;
}) {
  const key = `buppancho:catalog:${scope}`,
    raw = useSyncExternalStore(
      subscribe,
      () => read(key),
      () => "[]",
    );
  let selected: string[] = [];
  try {
    const list: unknown = JSON.parse(raw);
    if (Array.isArray(list))
      selected = list
        .filter((s): s is string => typeof s === "string" && /^[a-f0-9-]{36}$/.test(s))
        .slice(0, 200);
  } catch {}
  const [loaded, setLoaded] = useState<{
      key: string;
      rows: CatalogStock[];
      unavailable?: { id: string; name: string; label: string }[];
      error?: string;
    }>(),
    [retry, setRetry] = useState(0),
    [limit, setLimit] = useState(false);
  const mutation = useCommerceMutation("SKU_BATCH", { context, date, selection: selected });
  const request = JSON.stringify({ context, ids: selected });
  useEffect(() => {
    if (mutation.feedback.status === "APPLIED") write(key, []);
  }, [mutation.feedback.status, key]);
  useEffect(() => {
    if (!JSON.parse(request).ids.length) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/commerce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "selection",
            kind: "SKU_BATCH",
            payload: JSON.parse(request),
          }),
          signal: abort.signal,
        });
        const result = await response.json();
        if (!abort.signal.aborted)
          setLoaded({
            key: request,
            rows: result.rows ?? [],
            unavailable: result.unavailable ?? [],
            error: response.ok ? undefined : result.error,
          });
      } catch {
        if (!abort.signal.aborted)
          setLoaded({
            key: request,
            rows: [],
            error: "選択内容を確認できません。選択は保持しています。",
          });
      }
    })();
    return () => abort.abort();
  }, [request, retry]);
  const change = (ids: string[]) => {
    if (ids.length > 200) {
      setLimit(true);
      return;
    }
    setLimit(false);
    write(key, ids);
  };
  return (
    <div>
      <div className="catalog-selection-bar">
        <label className="commerce-checkbox">
          <input
            type="checkbox"
            aria-label="このページを全選択"
            checked={products.length > 0 && products.every((p) => selected.includes(p.id))}
            onChange={(e) =>
              change(
                e.target.checked
                  ? [...new Set([...selected, ...products.map((p) => p.id)])]
                  : selected.filter((id) => !products.some((p) => p.id === id)),
              )
            }
          />
          このページを全選択
        </label>
        <span aria-live="polite">{selected.length}件を選択</span>
        <button
          type="button"
          className="button"
          disabled={!selected.length || mutation.busy || mutation.frozen}
          onClick={() => void mutation.submit()}
        >
          単品の販売商品を一括登録
        </button>
        {selected.length > 0 && (
          <button type="button" className="commerce-text-button" onClick={() => change([])}>
            選択解除
          </button>
        )}
      </div>
      {limit && (
        <p role="alert" className="field-error">
          一度に登録できるのは200件までです。
        </p>
      )}
      {selected.length > 0 && (
        <details className="commerce-disclosure">
          <summary>選択内容</summary>
          {loaded?.key === request && loaded.error ? (
            <p role="alert">
              {loaded.error}
              <button type="button" onClick={() => setRetry((n) => n + 1)}>
                再確認
              </button>
            </p>
          ) : loaded?.key !== request ? (
            <p role="status">確認中…</p>
          ) : (
            selected.map((id) => {
              const available = loaded.rows.find((r) => r.id === id),
                p = available ?? loaded.unavailable?.find((r) => r.id === id);
              return (
                <div className="commerce-summary-line" key={id}>
                  <span>
                    {p?.name ?? id}
                    {!available && <small className="field-error">利用できない商品</small>}
                    {p && <small className="commerce-secondary">{p.label}</small>}
                  </span>
                  <button
                    type="button"
                    className="commerce-text-button"
                    onClick={() => change(selected.filter((v) => v !== id))}
                    aria-label={`${p?.name ?? "利用できない商品"}の選択を解除`}
                  >
                    解除
                  </button>
                </div>
              );
            })
          )}
        </details>
      )}
      <MutationFeedback mutation={mutation} />
      <div className="commerce-list">
        {products.map((p) => (
          <div className="commerce-row commerce-select-row" key={p.id}>
            <input
              type="checkbox"
              aria-label={`${p.label}を選択`}
              checked={selected.includes(p.id)}
              onChange={(e) =>
                change(
                  e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id),
                )
              }
            />
            <div>
              <Link
                href={`/products/items/${p.itemId}${p.unitId ? `?unit=${p.unitId}` : `?variant=${p.variantId}`}`}
              >
                <strong>{p.name}</strong>
              </Link>
              <span className="commerce-secondary">{p.label}</span>
            </div>
            <span>{p.quantity} 点</span>
          </div>
        ))}
      </div>
    </div>
  );
}
