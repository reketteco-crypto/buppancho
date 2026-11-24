"use client";
import { useEffect, useRef, useState } from "react";
import { PurchaseComparison, usePurchaseReview } from "@/components/forms/purchase-conflict-panel";
import type { PurchaseReview } from "@/lib/inventory/purchase-conflict";
import type { PurchaseBaseline } from "@/lib/inventory/purchase-comparison";
import { HydratedForm } from "@/components/forms/hydrated-form";
import { useSubmit, type InputContext } from "@/components/forms/workflow-forms";
import { useSharedValuation } from "@/components/forms/shared-valuation-preview";

export function PurchaseEventForm(props: {
  context: InputContext;
  purchaseId: string;
  revision: number;
  today: string;
  kind: "PURCHASE_RECEIVE" | "PURCHASE_CANCEL";
  review: PurchaseReview;
  initial?: {
    date?: string;
    reason?: string;
    revision?: number;
    baseSnapshot?: PurchaseBaseline | null;
  };
}) {
  const action = useSubmit(props.kind, props.context, "purchases");
  const [date, setDate] = useState(props.initial?.date ?? props.today);
  const [reason, setReason] = useState(props.initial?.reason ?? "");
  const receiving = props.kind === "PURCHASE_RECEIVE";
  const [revision, setRevision] = useState(props.initial?.revision ?? props.revision);
  const [baseline, setBaseline] = useState(
    props.initial ? (props.initial.baseSnapshot ?? null) : props.review.baseline,
  );
  const comparison = usePurchaseReview({
    context: props.context,
    purchaseId: props.purchaseId,
    initial: props.review,
    trigger: action.result.code,
  });
  const [accepted, setAccepted] = useState(false);
  const review = comparison.review ?? props.review;
  const contextBlocked =
    !!comparison.error ||
    ["YEAR_LOCKED", "OWNERSHIP_CHANGED", "CONTEXT_CHANGED"].includes(review.code ?? "");
  const stateBlocked =
    review.baseline?.status === "CANCELLED" || (receiving && review.baseline?.status !== "DRAFT");
  const conflict = contextBlocked || stateBlocked || review.baseline?.revision !== revision;
  const payload = { purchaseId: props.purchaseId, revision, baseSnapshot: baseline, date, reason };
  const valuation = useSharedValuation(
    props.kind,
    props.context,
    payload,
    !action.pending && !conflict,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const refreshComparison = comparison.refresh;
  useEffect(() => {
    if (
      ["CONFLICT", "YEAR_LOCKED", "CONTEXT_CHANGED", "OWNERSHIP_CHANGED"].includes(
        valuation.code ?? "",
      )
    )
      void refreshComparison();
  }, [valuation.code, refreshComparison]);
  useEffect(() => {
    if (conflict) heading.current?.focus();
  }, [conflict]);
  return (
    <HydratedForm
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (conflict || !valuation.ready) return;
        void action.submit({
          purchaseId: props.purchaseId,
          revision,
          baseSnapshot: baseline,
          date,
          reason,
          ...valuation.confirmation,
        });
      }}
    >
      {action.feedback}
      {conflict && (
        <section className="message" aria-label="仕入れ操作の変更確認">
          <h2 tabIndex={-1} ref={heading}>
            対象の仕入れが変更されています
          </h2>
          <p role="alert">
            {comparison.error ??
              (contextBlocked || stateBlocked
                ? review.message
                : "変更された仕入れを確認してから、同じ操作を改めて実行してください。")}
          </p>
          {review.input && (
            <PurchaseComparison
              baseline={baseline}
              remote={review.baseline}
              local={props.review.input ?? review.input}
              localValues={baseline?.values}
              labels={review.labels}
            />
          )}
          <p>
            手元の{receiving ? "入庫日" : "取消日"}：{date}／理由：{reason || "未入力"}
          </p>
          <button
            type="button"
            className="button secondary"
            onClick={() => void comparison.refresh()}
          >
            最新の変更を確認する
          </button>
          {!contextBlocked && !stateBlocked && !action.pending && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setRevision(review.baseline!.revision);
                setBaseline(review.baseline);
                setAccepted(true);
              }}
            >
              最新の仕入れを確認して入力を引き継ぐ
            </button>
          )}
          <p>選択だけでは入庫・取消は実行しません。</p>
        </section>
      )}
      {accepted && (
        <p className="message">
          最新の仕入れを確認しました。日付・理由を確認し、下のボタンで改めて
          {receiving ? "入庫" : "取消"}してください。
        </p>
      )}
      <fieldset disabled={action.pending || conflict}>
        <label className="field">
          <span>{receiving ? "届いた商品を在庫に加える日（入庫日）" : "取消日"}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <span className="field-error">{action.result.fields?.date}</span>
        </label>
        {!receiving && (
          <label className="field">
            <span>取消理由</span>
            <input
              placeholder="取消理由"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={1000}
            />
          </label>
        )}
        {valuation.panel}
        <button
          className={receiving ? "button" : "button danger"}
          disabled={action.pending || !valuation.ready}
        >
          {receiving ? "入庫して在庫に加える" : "仕入れを取り消す"}
        </button>
      </fieldset>
    </HydratedForm>
  );
}
