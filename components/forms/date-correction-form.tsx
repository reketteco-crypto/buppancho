"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { HydratedForm } from "@/components/forms/hydrated-form";
import { useSubmit, type InputContext } from "@/components/forms/workflow-forms";
import { useSharedValuation } from "@/components/forms/shared-valuation-preview";

export function DateCorrectionForm(props: {
  context: InputContext;
  operationId: string;
  currentDate: string;
  blocked?: string;
  initial?: { date: string; reason: string; previousDate: string };
}) {
  const router = useRouter();
  const action = useSubmit("DATE_CORRECT", props.context, "date-corrections");
  const [date, setDate] = useState(props.initial?.date ?? "");
  const [reason, setReason] = useState(props.initial?.reason ?? "");
  const [previousDate, setPreviousDate] = useState(
    props.initial?.previousDate ?? props.currentDate,
  );
  const [acceptedResult, setAcceptedResult] = useState<typeof action.result | null>(null);
  const payload = { operationId: props.operationId, previousDate, date, reason };
  const baseConflict =
    previousDate !== props.currentDate ||
    (action.result.code === "CONFLICT" && acceptedResult !== action.result);
  const preview = useSharedValuation(
    "DATE_CORRECT",
    props.context,
    payload,
    !action.pending && !props.blocked && !baseConflict && !!date && !!reason.trim(),
  );
  const conflict = baseConflict || preview.code === "CONFLICT";
  const fields = { ...preview.fields, ...action.result.fields };
  const form = useRef<HTMLFormElement>(null);
  const conflictHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (conflict) conflictHeading.current?.focus();
  }, [conflict]);
  useEffect(() => {
    if (action.result.error)
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [action.result]);
  return (
    <HydratedForm
      ref={form}
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!preview.ready || props.blocked || conflict) return;
        void action.submit({ ...payload, ...preview.confirmation });
      }}
    >
      {action.feedback}
      {props.blocked && (
        <p role="alert" className="message">
          {props.blocked} 入力・履歴と保存結果は閲覧できます。
        </p>
      )}
      {conflict && (
        <section className="message" aria-label="日付の変更確認">
          <h2 ref={conflictHeading} tabIndex={-1}>
            日付が変更されています
          </h2>
          <p>
            入力開始時：{previousDate}／現在：{props.currentDate}／手元の訂正予定：
            {date || "未入力"}
          </p>
          <p>訂正日・理由を保持しています。最新内容を読み直し、改めて影響を確認してください。</p>
          <button type="button" className="button secondary" onClick={() => router.refresh()}>
            入力を保持して最新の日付を読み直す
          </button>
          {(previousDate !== props.currentDate || action.result.code === "CONFLICT") && (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setPreviousDate(props.currentDate);
                setAcceptedResult(action.result);
                preview.refresh();
              }}
            >
              現在の日付を基準に手元入力を再確認する
            </button>
          )}
          <p>選択だけでは日付を訂正しません。</p>
        </section>
      )}
      <fieldset disabled={action.pending || !!props.blocked}>
        <label className="field">
          <span>訂正後の日付（日本時間）</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            min={`${props.context.year}-01-01`}
            max={`${props.context.year}-12-31`}
            required
            aria-invalid={!!fields.date}
            aria-describedby={fields.date ? "date-correction-date-error" : undefined}
          />
          {fields.date && (
            <span id="date-correction-date-error" className="field-error">
              {fields.date}
            </span>
          )}
        </label>
        <label className="field">
          <span>訂正理由（必須）</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            maxLength={1000}
            aria-invalid={!!fields.reason}
            aria-describedby={fields.reason ? "date-correction-reason-error" : undefined}
          />
          {fields.reason && (
            <span id="date-correction-reason-error" className="field-error">
              {fields.reason}
            </span>
          )}
        </label>
        <p className="muted">
          商品・数量は変更しません。元の日付を残し、必要な原価訂正だけを追記します。同じ未ロック年度内の訂正に限ります。
        </p>
        {date && reason.trim() ? (
          preview.panel
        ) : (
          <p>訂正後の日付と理由を入力すると、在庫・後続原価への影響を確認できます。</p>
        )}
        <button className="button" disabled={!preview.ready || conflict || action.pending}>
          影響を確認して日付を訂正する
        </button>
      </fieldset>
      <p className="muted">
        確定操作の前の入力は、この画面を閉じると復元できない場合があります。確定要求がサーバーへ届いた後は保存結果を照会できます。
      </p>
    </HydratedForm>
  );
}
