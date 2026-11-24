"use client";

import { useEffect, useState } from "react";
import type { BuyInput } from "@/lib/commerce/input";
import type { calculatePurchase } from "@/lib/commerce/purchase-calculation";
import {
  isQuantityStock,
  purchaseUnitCostLabel,
  type PurchaseCostPreview,
} from "@/lib/commerce/purchase-cost";
import { moneyLabel } from "./mutation";

export function PurchaseCostSummary({
  values,
  calculation,
  reason,
  position,
  onPositionChange,
}: {
  values: BuyInput;
  calculation: ReturnType<typeof calculatePurchase> | undefined;
  reason: string;
  position: string;
  onPositionChange: (value: string) => void;
}) {
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: PurchaseCostPreview;
    error?: string;
  }>();
  const payload = JSON.stringify({
    ...values,
    payment: undefined,
    memo: "",
    createSkus: false,
    valuationPosition: position || undefined,
  });
  const key = JSON.stringify({ payload, retry });
  const lines = values.lines.flatMap((line, index) =>
    isQuantityStock(line) && line.name ? [{ line, index }] : [],
  );
  const complete = !!calculation?.final;
  const enabled =
    complete &&
    lines.length > 0 &&
    values.lines.every((l) => !!l.name) &&
    !!values.date &&
    !!values.locationId;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/commerce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "purchase-cost-preview",
            kind: "BUY",
            payload: JSON.parse(payload),
          }),
          signal: controller.signal,
        });
        const body = (await response.json()) as {
          costPreview?: PurchaseCostPreview;
          error?: string;
          code?: string;
        };
        if (disposed) return;
        if (!response.ok || !body.costPreview)
          setResult({
            key,
            error:
              body.code && body.error
                ? body.error
                : "平均原価を取得できませんでした。再取得してください。",
          });
        else setResult({ key, data: body.costPreview });
      } catch {
        if (!disposed)
          setResult({ key, error: "平均原価を取得できませんでした。再取得してください。" });
      }
    }, 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [payload, key, enabled]);

  if (!lines.length) return null;
  const current = enabled && result?.key === key ? result : undefined;
  const data = current?.data;
  let averageStatus = "計算待ち";
  if (complete && enabled && !data) averageStatus = current?.error ? "要確認" : "計算中…";
  const pendingReason =
    reason ||
    calculation?.allocations.find((a) => a.missing)?.missing ||
    "商品金額・費用・配分条件を確認してください。";
  return (
    <section className="purchase-cost-summary" aria-labelledby="purchase-cost-heading">
      <h2 id="purchase-cost-heading">商品ごとの原価</h2>
      <table className="purchase-cost-table">
        <thead>
          <tr>
            <th>商品</th>
            <th>今回の仕入原価／個</th>
            <th>補充後の平均原価／個{!values.received && "・参考"}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(({ line, index }) => {
            const row = data?.rows.find((r) => r.clientId === line.clientId);
            const own = complete ? calculation!.landed[index]! : undefined;
            return (
              <tr key={line.clientId}>
                <th scope="row">
                  <span>{line.name}</span>
                  {own !== undefined && (
                    <details className="purchase-cost-breakdown">
                      <summary aria-label={`${line.name}の原価内訳`}>内訳</summary>
                      <dl>
                        <div>
                          <dt>今回の数量</dt>
                          <dd>{line.quantity}個</dd>
                        </div>
                        <div>
                          <dt>今回の原価合計</dt>
                          <dd>{moneyLabel(own)}</dd>
                        </div>
                        {row && (
                          <>
                            <div>
                              <dt>{values.received ? "入庫前の在庫" : "現在の在庫"}</dt>
                              <dd>{row.before.quantity}個</dd>
                            </div>
                            <div>
                              <dt>在庫原価合計</dt>
                              <dd>{moneyLabel(row.before.cost)}</dd>
                            </div>
                            <div>
                              <dt>補充後の在庫</dt>
                              <dd>{row.after.quantity}個</dd>
                            </div>
                            <div>
                              <dt>補充後の原価合計</dt>
                              <dd>{moneyLabel(row.after.cost)}</dd>
                            </div>
                          </>
                        )}
                      </dl>
                    </details>
                  )}
                </th>
                <td>
                  <span className="purchase-cost-mobile-label">今回の仕入原価／個</span>
                  <strong>
                    {own === undefined ? "計算待ち" : purchaseUnitCostLabel(own, line.quantity)}
                  </strong>
                </td>
                <td>
                  <span className="purchase-cost-mobile-label">
                    補充後の平均原価／個{!values.received && "・参考"}
                  </span>
                  <strong>
                    {row
                      ? purchaseUnitCostLabel(row.after.cost, row.after.quantity)
                      : averageStatus}
                  </strong>
                  {row && row.before.quantity > 0 && (
                    <small className="commerce-secondary">
                      {purchaseUnitCostLabel(row.before.cost, row.before.quantity)} →{" "}
                      {purchaseUnitCostLabel(row.after.cost, row.after.quantity)}
                    </small>
                  )}
                  {row?.provisional && <small className="commerce-secondary">暫定</small>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!complete && <p className="commerce-caption">計算待ち・{pendingReason}</p>}
      {complete && !values.received && (
        <p className="commerce-caption">
          現在の帳簿在庫を基準にした参考値です。実際の平均原価は受取時に決まります。
        </p>
      )}
      {complete && !enabled && (
        <p className="commerce-caption">
          商品名・購入日・保管場所を入力すると、補充後の平均原価を計算できます。
        </p>
      )}
      {data?.message && (
        <p className="commerce-caption" role="status">
          {data.message}
        </p>
      )}
      {data?.status === "ORDER_REQUIRED" && (
        <label className="field">
          同日の記録順序
          <select value={position} onChange={(e) => onPositionChange(e.target.value)}>
            <option value="">順序を選択</option>
            {data.choices?.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {current?.error && (
        <div role="status">
          <p className="commerce-caption">{current.error}</p>
          <button
            type="button"
            className="commerce-text-button"
            onClick={() => setRetry((n) => n + 1)}
          >
            平均原価を再取得
          </button>
        </div>
      )}
    </section>
  );
}
