"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import type { z } from "zod";
import type { listingReturnSchema, listingReturnCloseSchema } from "@/lib/validation/workflow";
import {
  useSubmit,
  useWorkflowDraft,
  type InputContext,
  type DraftInitial,
} from "@/components/forms/workflow-forms";
import { loadListingReturnDraftReviewAction } from "@/app/sales/workflow-actions";
import {
  listingReturnSnapshotValues,
  listingReturnPlannedValues,
  type ListingReturnDraftInput,
  type ListingReturnSnapshot,
} from "@/lib/sales/listing-return-input";
import type { ListingReturnDraftReview } from "@/lib/sales/listing-return-drafts";
import { useSharedValuation } from "@/components/forms/shared-valuation-preview";
import { HydratedForm } from "@/components/forms/hydrated-form";

const labels = {
  RESTOCK: "良品",
  DEFECTIVE: "不良（販売不可）",
  DISPOSED: "廃棄",
  LOST: "返送不要・紛失",
} as const;
const groups: Record<string, string> = {
  status: "状態",
  quantity: "構成品と数量",
  cost: "商品全体の原価残高・場所",
  context: "入力先・日付・理由",
};
export function ListingReturnForm(props: {
  context: InputContext;
  listingId: string;
  revision: number;
  today: string;
  blocked: boolean;
  canResume: boolean;
  allProcessed: boolean;
  members: { id: string; label: string; pending: number }[];
  initial?: z.output<typeof listingReturnSchema>;
  closing?: z.output<typeof listingReturnCloseSchema>;
  savedInput?: ListingReturnDraftInput;
  draft?: DraftInitial;
  baseline: ListingReturnSnapshot | null;
  review: ListingReturnDraftReview;
}) {
  const [context] = useState(
    props.baseline?.context ?? props.initial?.context ?? props.closing?.context ?? props.context,
  );
  const [baseline] = useState(props.baseline),
    [review, setReview] = useState(props.review),
    [savedAtStart] = useState(props.savedInput);
  const [checking, setChecking] = useState(
    !!props.review.code || (!!baseline && baseline.revision !== props.review.snapshot.revision),
  );
  const [message, setMessage] = useState<string>(),
    [working, setWorking] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const contextChanged =
    context.businessUnitId !== props.context.businessUnitId ||
    context.operatorId !== props.context.operatorId ||
    context.year !== props.context.year;
  const action = useSubmit("LISTING_RETURN", context, "listings"),
    close = useSubmit("LISTING_RETURN_CLOSE", context, "listings"),
    resolution = useSubmit("LISTING_RETURN_REBASE", context, "draft");
  const [date, setDate] = useState(
    props.savedInput?.date ?? props.initial?.date ?? props.closing?.date ?? props.today,
  );
  const [reason, setReason] = useState(
    props.savedInput?.reason ?? props.initial?.reason ?? props.closing?.reason ?? "",
  );
  const [quantities, setQuantities] = useState<Record<string, string>>(
    () =>
      props.savedInput?.quantities ??
      Object.fromEntries(
        props.initial?.rows.map((r) => [r.memberId + ":" + r.disposition, String(r.quantity)]) ??
          [],
      ),
  );
  const [goods, setGoods] = useState(props.savedInput?.goodsInHand ?? false);
  const [ending, setEnding] = useState<"END" | "RESUME">(
    props.savedInput?.closeAction ?? props.closing?.action ?? "END",
  );
  const [mode, setMode] = useState<"HANDLE" | "CLOSE">(props.savedInput?.mode ?? "HANDLE");
  const revision =
    baseline?.revision ?? props.initial?.revision ?? props.closing?.revision ?? props.revision;
  const members = review.snapshot.members;
  const input: ListingReturnDraftInput = {
    listingId: props.listingId,
    caseId: baseline?.caseId ?? review.snapshot.caseId,
    mode,
    date,
    reason,
    quantities,
    closeAction: ending,
    goodsInHand: goods,
  };
  const busy =
    props.blocked ||
    contextChanged ||
    action.pending ||
    close.pending ||
    resolution.pending ||
    working ||
    review.activeRequest?.status === "PREPARED";
  const draft = useWorkflowDraft(
    "LISTING_RETURN",
    context,
    input,
    props.draft,
    !busy && !checking,
    baseline,
  );
  const rows = members.flatMap((m) =>
    Object.keys(labels).flatMap((disposition) => {
      const value = quantities[m.id + ":" + disposition];
      return value && value !== "0"
        ? [{ memberId: m.id, disposition, quantity: /^\d+$/.test(value) ? Number(value) : null }]
        : [];
    }),
  );
  const metadata = {
    draftId: draft.id,
    draftRevision: draft.revision,
    baseSnapshot: baseline,
    draftInput: { ...input, mode: "HANDLE" },
  };
  const payload = { listingId: props.listingId, revision, date, reason, rows, ...metadata };
  const disabled = busy || checking || !!draft.conflict;
  const preview = useSharedValuation(
    "LISTING_RETURN",
    context,
    payload,
    !disabled && rows.length > 0 && !!reason.trim(),
  );
  const refresh = useCallback(async () => {
    const result = await loadListingReturnDraftReviewAction({
      context,
      listingId: props.listingId,
      draftId: draft.id,
    });
    if (result.review) {
      setReview(result.review);
      setChecking(
        !!result.review.code ||
          !!draft.conflict ||
          (!!baseline && baseline.revision !== result.review.snapshot.revision),
      );
    } else {
      setMessage(result.error ?? "最新状態を確認できません。入力を保持しています。");
      setChecking(true);
    }
    return result.review;
  }, [context, props.listingId, draft.id, draft.conflict, baseline]);
  useEffect(() => {
    const read = () => {
      void refresh().catch(() => {
        setMessage("接続後に最新状態を確認してください。入力は保持しています。");
        setChecking(true);
      });
    };
    window.addEventListener("focus", read);
    window.addEventListener("online", read);
    return () => {
      window.removeEventListener("focus", read);
      window.removeEventListener("online", read);
    };
  }, [refresh]);
  useEffect(() => {
    if (checking || draft.conflict) heading.current?.focus();
  }, [checking, draft.conflict]);
  useEffect(() => {
    if (
      [action.result.code, close.result.code, draft.issue].some(
        (code) => code === "CONFLICT" || code === "YEAR_LOCKED" || code === "OWNERSHIP_CHANGED",
      )
    ) {
      queueMicrotask(() => {
        setChecking(true);
        void refresh().catch(() =>
          setMessage("最新状態の取得に失敗しました。入力を保持しています。"),
        );
      });
    }
    if (
      action.result.status === "CANCELLED" ||
      close.result.status === "CANCELLED" ||
      resolution.result.status === "CANCELLED"
    )
      queueMicrotask(() => {
        void refresh().catch(() =>
          setMessage("要求の取消結果を確認後、もう一度読み直してください。"),
        );
      });
  }, [
    action.result.code,
    close.result.code,
    draft.issue,
    action.result.status,
    close.result.status,
    resolution.result.status,
    refresh,
  ]);
  const choose = async (choice: "LOCAL" | "NEW") => {
    setWorking(true);
    setMessage(undefined);
    try {
      await draft.prepare(true);
      const latest = await refresh();
      if (!latest?.canResolve)
        throw new Error(latest?.message ?? "元の保存要求の結果を先に確認してください。");
      if (
        latest.fingerprint !== review.fingerprint ||
        latest.draftRevision !== review.draftRevision
      )
        throw new Error(
          "比較中に更新されました。表示した最新内容を確認し、もう一度選択してください。",
        );
      await resolution.submit({
        listingId: props.listingId,
        draftId: draft.id,
        draftRevision: latest.draftRevision,
        currentFingerprint: latest.fingerprint,
        choice,
        input,
        baseSnapshot: baseline,
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "選び直しの結果を確認してください。");
    } finally {
      draft.resume();
      setWorking(false);
    }
  };
  const before = listingReturnSnapshotValues(baseline),
    current = listingReturnSnapshotValues(review.snapshot),
    local = listingReturnPlannedValues(input, baseline ?? review.snapshot);
  const remote = review.savedInput
    ? listingReturnPlannedValues(review.savedInput, review.snapshot)
    : null;
  const allProcessed = members.length > 0 && members.every((m) => m.pending === 0),
    canResume = members.length > 0 && members.every((m) => m.good === m.quantity);
  const readLatest = () => {
    void refresh().catch(() => setMessage("接続後に再確認してください。入力は保持しています。"));
  };
  return (
    <div className="form-stack">
      {contextChanged && (
        <p role="alert">入力先は付け替えていません。元の入力者・部門・年度へ戻してください。</p>
      )}
      <p className="message">
        良品と未返送分は、案件を閉じるまで確保を維持します。確認した数量だけ入力してください。0・空欄は今回未処理です。メルカリ側の操作は行いません。
      </p>
      <p role="status">{draft.status}</p>
      {message && <p role="alert">{message}</p>}
      {draft.issue && (
        <p role="alert">入力先・年度・保存状態を確認してください。元の入力は保持しています。</p>
      )}
      {review.activeRequest && (
        <a
          className="button secondary"
          href={
            "/sales/listings/" +
            props.listingId +
            "/return?draft=" +
            draft.id +
            "&operation=" +
            review.activeRequest.id +
            "&operationKind=" +
            review.activeRequest.kind
          }
        >
          元の保存要求を確認する
        </a>
      )}
      <button type="button" className="button secondary" disabled={busy} onClick={readLatest}>
        手元入力を保持して最新の返送状況を読む
      </button>
      {(checking || draft.conflict) && (
        <section className="card form-stack">
          <h2 ref={heading} tabIndex={-1}>
            返送入力の変更を確認してください
          </h2>
          <p>
            {review.message ??
              "自動で上書き・数量調整・在庫確定は行いません。全体を選び直して再確認してください。"}
          </p>
          {Object.keys(groups)
            .sort((a, b) => Number(before[b] !== current[b]) - Number(before[a] !== current[a]))
            .map((key) => (
              <article
                key={key}
                className="card"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                <h3>
                  {groups[key]}
                  {before[key] !== current[key] ? "（変更あり）" : ""}
                </h3>
                <p>入力開始時：{baseline ? before[key] : "入力開始時の記録は未保存"}</p>
                {savedAtStart && (
                  <p>
                    入力開始時の下書き：
                    {listingReturnPlannedValues(savedAtStart, baseline ?? review.snapshot)[key]}
                  </p>
                )}
                <p>現在の記録：{current[key]}</p>
                {remote && <p>現在保存されている入力：{remote[key]}</p>}
                <p>手元の予定：{local[key]}</p>
              </article>
            ))}
          {resolution.feedback}
          <button
            type="button"
            className="button"
            disabled={busy || !review.canResolve}
            onClick={() => void choose("LOCAL")}
          >
            手元入力を引き継いで再確認する
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !review.canResolve}
            onClick={() => void choose("NEW")}
          >
            手元入力を退避して新しく入力する
          </button>
        </section>
      )}
      {review.previous && (
        <details className="card">
          <summary>選び直す前の手元入力を確認する</summary>
          {Object.entries(
            listingReturnPlannedValues(review.previous.input, baseline ?? review.snapshot),
          ).map(([key, value]) => (
            <p key={key} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {value}
            </p>
          ))}
        </details>
      )}
      <HydratedForm
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (preview.ready)
            void action
              .submit(async () => ({
                ...payload,
                draftRevision: await draft.prepare(),
                ...preview.confirmation,
              }))
              .finally(() => draft.resume());
        }}
      >
        {action.feedback}
        <fieldset disabled={disabled}>
          <label className="field">
            <span>返送を確認した日</span>
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          {members.map((m) => (
            <section key={m.id} className="card form-stack">
              <h3>{m.label}</h3>
              <p>未処理：{m.pending}個</p>
              {Object.entries(labels).map(([key, label]) => (
                <label key={key} className="field">
                  <span>{label}として今回確認した数量</span>
                  <input
                    type="number"
                    min={0}
                    max={m.pending}
                    step={1}
                    value={quantities[m.id + ":" + key] ?? ""}
                    onChange={(e) =>
                      setQuantities({ ...quantities, [m.id + ":" + key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </section>
          ))}
          <label className="field">
            <span>確認理由・メモ（必須）</span>
            <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {rows.length > 0 && preview.panel}
          {rows.length > 0 && (
            <button
              type="button"
              className="button secondary"
              disabled={disabled}
              onClick={() => preview.refresh()}
            >
              在庫と原価への影響を読み直す
            </button>
          )}
          {action.result.code === "VALUATION_REQUIRED" && (
            <p role="alert">
              確認後に在庫・原価の条件が更新されました。上のボタンで影響を読み直し、再確認してから記録してください。
            </p>
          )}
          <button className="button" disabled={!preview.ready || disabled}>
            今回確認した返送分を記録する
          </button>
          <p className="muted">
            「保存済み」の入力はホームと出品詳細から再開できます。未送信入力はタブ破棄後まで復元できるとは限りません。通信復帰時に確定処理は自動実行しません。
          </p>
        </fieldset>
      </HydratedForm>
      {allProcessed && (
        <HydratedForm
          className="card form-stack"
          onFocus={() => setMode("CLOSE")}
          onSubmit={(e) => {
            e.preventDefault();
            void close
              .submit(async () => ({
                listingId: props.listingId,
                revision,
                date,
                reason,
                action: ending,
                goodsInHand: goods,
                draftId: draft.id,
                draftRevision: await draft.prepare(),
                baseSnapshot: baseline,
                draftInput: { ...input, mode: "CLOSE" },
              }))
              .finally(() => draft.resume());
          }}
        >
          <h2>全数の確認後の処理</h2>
          {close.feedback}
          <fieldset disabled={disabled}>
            <label className="field">
              <span>返送案件を閉じる方法</span>
              <select
                value={ending}
                onChange={(e) => setEnding(e.target.value as "END" | "RESUME")}
              >
                <option value="END">終了して良品分の確保を解除</option>
                {canResume && (
                  <option value="RESUME">元の構成が全量良品・メルカリの再開を確認して再開</option>
                )}
              </select>
            </label>
            {!canResume && (
              <p>
                不良・廃棄・紛失があるため、同じ出品の再開はできません。別の在庫による補充再開は行いません。
              </p>
            )}
            <label className="checkbox-field">
              <input
                type="checkbox"
                required
                checked={goods}
                onChange={(e) => setGoods(e.target.checked)}
              />
              現物の所在と処理結果を確認した（再開時は元の構成全量とメルカリの再開も確認）
            </label>
            <p>上の日付・理由で記録します。選択しただけでは終了・再開しません。</p>
            <button className="button secondary" disabled={!goods || !reason.trim() || disabled}>
              確認して返送案件を閉じる
            </button>
          </fieldset>
        </HydratedForm>
      )}
    </div>
  );
}
