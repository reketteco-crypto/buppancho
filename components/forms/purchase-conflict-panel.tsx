"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { loadPurchaseReviewAction } from "@/app/sales/workflow-actions";
import type { PurchaseReview } from "@/lib/inventory/purchase-conflict";
import {
  purchaseDifferences,
  purchaseValues,
  type PurchaseBaseline,
  type PurchaseLabels,
} from "@/lib/inventory/purchase-comparison";
import type { PurchaseUiSnapshot } from "@/components/forms/purchase-form";
import { useSubmit, type InputContext } from "@/components/forms/workflow-forms";

export function usePurchaseReview(props: {
  context: InputContext;
  purchaseId?: string;
  draftId?: string;
  initial?: PurchaseReview;
  trigger?: string;
}) {
  const [review, setReview] = useState(props.initial);
  const [error, setError] = useState<string>();
  const { businessUnitId, operatorId, year } = props.context;
  const refresh = useCallback(async () => {
    try {
      const result = await loadPurchaseReviewAction({
        context: { businessUnitId, operatorId, year },
        purchaseId: props.purchaseId,
        draftId: props.draftId,
      });
      setError(result.error);
      if (result.review) setReview(result.review);
    } catch {
      setError(
        "通信を確認中です。手元の入力を保持しています。接続後に最新の変更を確認してください。",
      );
    }
  }, [businessUnitId, operatorId, year, props.purchaseId, props.draftId]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (props.trigger) queueMicrotask(() => void refresh());
  }, [props.trigger, refresh]);
  return { review, error, refresh };
}

export function PurchaseComparison({
  baseline,
  remote,
  local,
  labels,
  localValues,
}: {
  baseline: PurchaseBaseline | null;
  remote: PurchaseBaseline | null;
  local: PurchaseUiSnapshot;
  labels: PurchaseLabels;
  localValues?: Record<string, string>;
}) {
  const rows = purchaseDifferences(
    baseline?.values ?? null,
    remote?.values ?? {},
    localValues ?? purchaseValues(local, labels),
  );
  return (
    <div className="form-stack">
      {rows
        .filter((row) => row.key !== "products" || row.changed || row.local !== "なし")
        .map((row) => (
          <section
            className="card"
            key={row.key}
            style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
          >
            <h3>
              {row.label}
              {row.changed ? "（変更あり）" : ""}
            </h3>
            <p>入力開始時：{row.base}</p>
            <p>現在の保存内容：{row.remote}</p>
            <p>手元の入力：{row.local}</p>
          </section>
        ))}
    </div>
  );
}

export function PurchaseConflictPanel(props: {
  context: InputContext;
  purchaseId?: string;
  draftId: string;
  baseline: PurchaseBaseline | null;
  local: PurchaseUiSnapshot;
  review?: PurchaseReview;
  labels: PurchaseLabels;
  error?: string;
  refresh: () => Promise<void>;
  prepare: () => Promise<unknown>;
  blocked: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const resolution = useSubmit("PURCHASE_REBASE", props.context, "draft");
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const review = props.review;
  return (
    <section className="message" aria-label="仕入れの変更確認">
      <h2 ref={heading} tabIndex={-1}>
        仕入れの変更を確認してください
      </h2>
      <p role="alert">
        {props.error ??
          review?.message ??
          "自動では上書きしません。最新の保存内容と手元の入力を比較してください。"}
      </p>
      <PurchaseComparison
        baseline={props.baseline}
        remote={review?.baseline ?? null}
        local={props.local}
        labels={review?.labels ?? props.labels}
      />
      {resolution.feedback}
      <div className="button-row">
        <button
          type="button"
          className="button secondary"
          onClick={() => void props.refresh()}
          disabled={resolution.pending}
        >
          最新の変更を確認する
        </button>
        {!props.blocked &&
          !props.error &&
          review?.canResolve &&
          (["LATEST", "LOCAL"] as const).map((choice) => (
            <button
              type="button"
              className="button"
              key={choice}
              disabled={resolution.pending}
              onClick={() =>
                void resolution.submit(async () => {
                  await props.prepare();
                  return {
                    purchaseId: props.purchaseId,
                    draftId: props.draftId,
                    draftRevision: review.draftRevision,
                    purchaseRevision: review.baseline?.revision ?? 0,
                    choice,
                    baseSnapshot: props.baseline,
                    local: props.local,
                  };
                })
              }
            >
              {choice === "LATEST" ? "最新の保存内容を使う" : "手元の入力を引き継いで再確認する"}
            </button>
          ))}
      </div>
      <p>選択だけでは仕入れ保存・入庫・取消を実行しません。元の入力は記録を残して退避します。</p>
      {review?.baseline?.purchaseId && (
        <Link href={`/purchases/${review.baseline.purchaseId}`}>最新の仕入れ実績を確認する</Link>
      )}
    </section>
  );
}
