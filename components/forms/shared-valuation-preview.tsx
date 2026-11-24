"use client";
import { useEffect, useState } from "react";
import type { SharedValuationPreview } from "@/lib/inventory/shared-valuation";
import type { InputContext } from "@/components/forms/workflow-forms";
type Kind =
  | "INVENTORY"
  | "PURCHASE_RECEIVE"
  | "PURCHASE_CANCEL"
  | "DATE_CORRECT"
  | "STOCKTAKE"
  | "LISTING_RETURN";
const yen = (value: string | null) =>
  value === null ? "未確認" : `¥${BigInt(value).toLocaleString("ja-JP")}`;
export function useSharedValuation(
  kind: Kind,
  context: InputContext,
  payload: object,
  enabled = true,
) {
  const [preview, setPreview] = useState<SharedValuationPreview>();
  const [previewKey, setPreviewKey] = useState("");
  const [position, setPosition] = useState("");
  const [error, setError] = useState<string>();
  const [code, setCode] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify({ kind, payload, context, valuationPosition: position || undefined });
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setWorking(true);
      try {
        const input = JSON.parse(key) as {
          kind: Kind;
          payload: object;
          context: InputContext;
          valuationPosition?: string;
        };
        const result = await fetch("/api/workflow/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: input.kind,
            payload: {
              ...input.payload,
              context: input.context,
              valuationPosition: input.valuationPosition,
            },
          }),
          signal: abort.signal,
        }).then((r) => r.json());
        if (abort.signal.aborted) return;
        setPreview(result.preview);
        setPreviewKey(key);
        setError(result.error);
        setCode(result.code);
        setFields(result.fields ?? {});
      } catch {
        if (!abort.signal.aborted)
          setError("影響を確認できません。入力を保持しています。接続後に再確認してください。");
      } finally {
        if (!abort.signal.aborted) setWorking(false);
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [key, enabled, retry]);
  const ready = !!preview && previewKey === key && !preview.requiresOrder && !error && !working;
  const refresh = () => {
    setPreviewKey("");
    setRetry((v) => v + 1);
  };
  return {
    ready,
    refresh,
    code: previewKey === key ? code : undefined,
    fields,
    confirmation: ready
      ? { valuationFingerprint: preview.fingerprint, valuationPosition: position || undefined }
      : {},
    panel: (
      <section className="card form-stack" aria-label="在庫と原価への影響">
        <h3>在庫と原価への影響</h3>
        {working || previewKey !== key ? (
          <p role="status">入力した日付の影響を確認中です。</p>
        ) : null}
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button type="button" className="button secondary" onClick={refresh}>
              入力を保持して影響を再確認する
            </button>
          </>
        ) : null}
        {preview && previewKey === key && (
          <>
            {preview.stocktake && (
              <p>
                数えた時点の帳簿数：{preview.stocktake.bookQuantity}個 → 実測：
                {preview.stocktake.countedQuantity}個（差：
                {preview.stocktake.difference > 0 ? "+" : ""}
                {preview.stocktake.difference}個）
              </p>
            )}
            {(preview.requiresOrder || position) && (
              <label className="field">
                <span>同日の計算順序</span>
                <select
                  aria-label="同日の計算順序"
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                >
                  <option value="">原価・在庫が変わるため選択してください</option>
                  {preview.choices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p>今回の払出原価：{yen(preview.cost)}</p>
            {preview.orderImpacts.map((o, i) => (
              <div key={i}>
                <p>
                  {o.name}（{o.date}）
                </p>
                <p>
                  管理原価 {yen(o.beforeCost)} → {yen(o.afterCost)}
                </p>
                <p>
                  管理利益 {yen(o.beforeProfit)} → {yen(o.afterProfit)}
                </p>
              </div>
            ))}
            {preview.balances.map((b) => (
              <p key={`${b.variantId}:${b.trackingMode}`}>
                記録後の管理残数 {b.quantity}個／原価残高 {yen(b.before)} → {yen(b.after)}
              </p>
            ))}
            <p>
              {preview.changes.length}件の原価訂正。元の数量移動を作り直さず、訂正履歴を追加します。
            </p>
          </>
        )}
      </section>
    ),
  };
}
