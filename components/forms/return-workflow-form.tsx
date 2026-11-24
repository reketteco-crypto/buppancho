"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  loadReturnReviewAction,
  previewReturnAction,
  type WorkflowFeedback,
} from "@/app/sales/workflow-actions";
import {
  returnMoneyKeys,
  returnMoneyLabels,
  dispositionNames,
  returnSnapshotValues,
  returnPlannedValues,
  validateReturnInput,
  type ReturnInput,
  type ReturnSnapshot,
} from "@/lib/sales/return-types";
import type { ReturnReview, ReturnPreview } from "@/lib/sales/return-workflow";
import { HydratedForm } from "@/components/forms/hydrated-form";
import {
  useSubmit,
  useWorkflowDraft,
  type InputContext,
  type DraftInitial,
} from "@/components/forms/workflow-forms";

const money = (v: string) => `¥${BigInt(v).toLocaleString("ja-JP")}`;
const names: Record<string, string> = {
  status: "記録状態",
  quantity: "商品・返品可能数",
  money: "返金・返還",
  cost: "構成品・有効原価・場所",
  expenses: "元取引の費用",
  date: "完了日／予定の処理日",
  memo: "今回のメモ・理由",
  ownership: "入力先・帰属",
};
function Comparison(props: {
  baseline: ReturnSnapshot | null;
  current: ReturnSnapshot;
  input: ReturnInput;
}) {
  const a = returnSnapshotValues(props.baseline),
    b = returnSnapshotValues(props.current),
    d = returnPlannedValues(props.input, props.current);
  const keys = Object.keys(names).sort((x, y) => Number(a[y] !== b[y]) - Number(a[x] !== b[x]));
  return (
    <div className="form-stack">
      {keys.map((k) => (
        <section
          className="card"
          key={k}
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          <h3>
            {names[k]}
            {props.baseline && a[k] !== b[k] ? "（変更あり）" : ""}
          </h3>
          <p>入力開始時：{props.baseline ? (a[k] ?? "なし") : "入力開始時の実績は未記録"}</p>
          <p>現在の実績：{b[k] ?? "なし"}</p>
          <p>今回の手元の予定：{d[k] ?? "現在の実績で再確認が必要"}</p>
        </section>
      ))}
    </div>
  );
}
export function ReturnWorkflowForm(props: {
  context: InputContext;
  initial: ReturnInput;
  baseline: ReturnSnapshot | null;
  review: ReturnReview;
  draft?: DraftInitial;
  forceReview?: boolean;
  compact?: boolean;
}) {
  const [input, setInput] = useState(props.initial),
    [baseline] = useState(props.baseline),
    [review, setReview] = useState(props.review);
  const [checking, setChecking] = useState(
    !!props.forceReview ||
      !!props.review.code ||
      (!!baseline && baseline.revision !== props.review.snapshot.revision),
  );
  const [readError, setReadError] = useState<string>(),
    [preview, setPreview] = useState<ReturnPreview>(),
    [previewInput, setPreviewInput] = useState("");
  const [feedback, setFeedback] = useState<WorkflowFeedback>({}),
    [working, setWorking] = useState(false);
  const [valuationPosition, setValuationPosition] = useState(
    props.compact &&
      props.initial.date === new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })
      ? "LAST"
      : "",
  );
  const [previewPosition, setPreviewPosition] = useState("");
  const action = useSubmit(input.kind, props.context, "orders"),
    resolution = useSubmit("RETURN_REBASE", props.context, "draft");
  const pending = action.pending || resolution.pending || working;
  const draft = useWorkflowDraft(
    input.kind,
    props.context,
    input,
    props.draft,
    !pending && !checking,
    baseline,
  );
  const refresh = useCallback(async () => {
    try {
      const result = await loadReturnReviewAction({
        context: props.context,
        orderId: input.orderId,
        kind: input.kind,
        draftId: draft.id,
      });
      setReadError(result.error);
      if (result.review) setReview(result.review);
    } catch {
      setReadError("通信を確認中です。手元入力を保持して、接続後に最新実績を確認してください。");
    }
  }, [props.context, input.orderId, input.kind, draft.id]);
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", handler);
    document.addEventListener("visibilitychange", handler);
    return () => {
      window.removeEventListener("focus", handler);
      document.removeEventListener("visibilitychange", handler);
    };
  }, [refresh]);
  const trigger = draft.conflict
    ? `draft:${draft.conflict.revision}`
    : (draft.issue ?? action.result.code ?? resolution.result.code ?? action.result.status);
  useEffect(() => {
    if (trigger) queueMicrotask(() => void refresh());
  }, [trigger, refresh]);
  const conflict =
    !!draft.conflict ||
    !!readError ||
    !!review.code ||
    !!review.activeRequest ||
    (!!baseline && baseline.revision !== review.snapshot.revision) ||
    [
      "CONFLICT",
      "VALUATION_REQUIRED",
      "YEAR_LOCKED",
      "OWNERSHIP_CHANGED",
      "CONTEXT_CHANGED",
    ].includes(action.result.code ?? "");
  useEffect(() => {
    if (conflict) queueMicrotask(() => setChecking(true));
  }, [conflict]);
  useEffect(() => {
    if (
      action.result.status === "CANCELLED" &&
      !review.activeRequest &&
      !review.code &&
      !draft.conflict &&
      (!baseline || baseline.revision === review.snapshot.revision) &&
      !props.forceReview
    )
      queueMicrotask(() => {
        setChecking(false);
        setPreview(undefined);
      });
  }, [
    action.result.status,
    review.activeRequest,
    review.code,
    review.snapshot.revision,
    draft.conflict,
    baseline,
    props.forceReview,
  ]);
  const heading = useRef<HTMLHeadingElement>(null),
    errorHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (checking) heading.current?.focus();
  }, [checking]);
  useEffect(() => {
    if (feedback.error) errorHeading.current?.focus();
  }, [feedback.error]);
  const fields = { ...feedback.fields, ...action.result.fields };
  const currentLine = review.snapshot.lines.find((l) => l.id === input.lineId);
  const ready =
    preview &&
    previewInput === JSON.stringify(input) &&
    previewPosition === valuationPosition &&
    !preview.valuation?.requiresOrder &&
    preview.revision === review.snapshot.revision &&
    (input.kind === "REFUND" || preview.inventoryRevision === review.snapshot.inventoryRevision) &&
    preview.snapshot.yearVersion === review.snapshot.yearVersion &&
    !checking &&
    !conflict;
  const update = (next: Partial<ReturnInput>) => {
    setInput((v) => ({ ...v, ...next }));
    setPreview(undefined);
    setFeedback({});
  };
  const confirm = async () => {
    setWorking(true);
    setFeedback({});
    try {
      await draft.prepare();
      const result = await previewReturnAction({
        context: props.context,
        kind: input.kind,
        orderId: input.orderId,
        draftId: draft.id,
        input,
        baseSnapshot: baseline,
        valuationPosition: valuationPosition || undefined,
      });
      setFeedback(result);
      setPreview(result.preview);
      setPreviewInput(JSON.stringify(input));
      setPreviewPosition(valuationPosition);
      if (result.error) errorHeading.current?.focus();
    } catch {
      setFeedback({
        error: "確認結果を取得できません。入力は保持しています。接続後にもう一度確認してください。",
      });
    } finally {
      draft.resume();
      setWorking(false);
    }
  };
  const ownErrors = Object.values(validateReturnInput(input).fields);
  return (
    <HydratedForm
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void action
          .submit(async () => ({
            kind: input.kind,
            orderId: input.orderId,
            input,
            draftId: draft.id,
            draftRevision: await draft.prepare(),
            orderRevision: preview.revision,
            confirmationFingerprint: preview.fingerprint,
            baseSnapshot: baseline,
            ...(input.kind === "RETURN" && preview.valuation
              ? {
                  valuationFingerprint: preview.valuation.fingerprint,
                  valuationPosition: valuationPosition || undefined,
                }
              : {}),
          }))
          .finally(draft.resume);
      }}
    >
      <p role="status" className={props.compact ? "commerce-caption" : undefined}>
        {draft.status}
        {!props.compact && "・途中保存では返品・返金・在庫は更新しません。"}
      </p>
      {review.closing && (
        <p className="notice">対象年度は決算処理中です。処理日と帰属を確認してください。</p>
      )}
      {action.feedback}
      {resolution.feedback}
      {(checking || conflict) && (
        <section className="message" aria-label="返品・返金の変更確認">
          <h2 ref={heading} tabIndex={-1}>
            返品・返金の変更を確認してください
          </h2>
          <p role="alert">
            {readError ??
              review.message ??
              action.result.error ??
              "実績が別操作で変更されました。手元の予定を自動では減額・上書きしません。"}
          </p>
          <Comparison baseline={baseline} current={review.snapshot} input={input} />
          <div className="button-row">
            {review.activeRequest && (
              <Link
                className="button"
                href={`/sales/orders/${input.orderId}/return?kind=${input.kind}&draft=${draft.id}&operation=${review.activeRequest.id}&operationKind=${review.activeRequest.kind}`}
              >
                元の保存要求の結果を確認する
              </Link>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={pending}
              onClick={() => void refresh()}
            >
              最新の実績を確認する
            </button>
            {!readError &&
              review.canResolve &&
              !review.activeRequest &&
              !action.pending &&
              (["LOCAL", "NEW"] as const).map((choice) => (
                <button
                  type="button"
                  className="button"
                  key={choice}
                  disabled={resolution.pending}
                  onClick={() =>
                    void resolution.submit(async () => {
                      await draft.prepare(true);
                      const latest = await loadReturnReviewAction({
                        context: props.context,
                        kind: input.kind,
                        orderId: input.orderId,
                        draftId: draft.id,
                      });
                      if (
                        !latest.review ||
                        latest.review.snapshot.revision !== review.snapshot.revision
                      ) {
                        void refresh();
                        throw new Error(
                          latest.error ??
                            "比較中に実績が再更新されました。最新の差分を確認してください。",
                        );
                      }
                      return {
                        kind: input.kind,
                        orderId: input.orderId,
                        draftId: draft.id,
                        draftRevision: latest.review.draftRevision,
                        orderRevision: review.snapshot.revision,
                        choice,
                        input,
                        baseSnapshot: baseline,
                      };
                    })
                  }
                >
                  {choice === "LOCAL"
                    ? "手元の入力を引き継いで再確認"
                    : "手元の入力を退避して新しく入力"}
                </button>
              ))}
          </div>
          <p>選択だけでは返品・返金・在庫は確定しません。元入力は退避して残します。</p>
          <Link href={`/sales/orders/${input.orderId}`}>最新の完了実績・返品履歴を確認する</Link>
          {input.kind === "RETURN" && !review.canResolve && (
            <Link href={`/sales/orders/${input.orderId}/return?kind=REFUND`}>
              在庫を変えずに返金を記録する画面へ
            </Link>
          )}
        </section>
      )}
      {review.previous && (
        <details className="card">
          <summary>選び直す前の手元入力を確認する</summary>
          <p>退避した入力です。この表示から業務記録は更新しません。</p>
          <Comparison
            baseline={review.previous.baseline}
            current={review.snapshot}
            input={review.previous.input}
          />
        </details>
      )}
      {review.previous?.choice === "LOCAL" && (
        <p className="notice">
          手元入力を引き継ぎました。数量・金額を自動で減らしていません。最新実績をもとに内容を確認し、通常の確認・確定操作を行ってください。
        </p>
      )}
      {feedback.error && (
        <section role="alert" className="message error">
          <h2 ref={errorHeading} tabIndex={-1}>
            入力・確認内容を修正してください
          </h2>
          <p>{feedback.error}</p>
          {feedback.fields && (
            <ul>
              {Object.values(feedback.fields).map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      <fieldset
        disabled={pending || checking || conflict}
        className="form-stack"
        style={{ minWidth: 0, border: 0, padding: 0 }}
      >
        {!props.compact && (
          <p>
            {input.kind === "RETURN"
              ? "現物と返金・返還金額を確認してから返品を確定します。セットの一部は構成品ごとの数量で記録できます。"
              : "返金・返還のみを記録します。現物・数量・在庫は変更しません。"}
          </p>
        )}
        <label className="field">
          <span>{input.kind === "RETURN" ? "返品日" : "返金・返還日"}</span>
          <input
            aria-label={input.kind === "RETURN" ? "返品日" : "返金・返還日"}
            type="date"
            value={input.date}
            onChange={(e) => update({ date: e.target.value })}
            required
          />
          <span className="field-error">{fields.date ?? fields["input.date"]}</span>
        </label>
        {input.kind === "RETURN" && (
          <>
            <label className="field">
              <span>返品する商品・セット</span>
              <select
                aria-label="返品する商品・セット"
                value={input.lineId}
                onChange={(e) =>
                  update({
                    lineId: e.target.value,
                    dispositions: {},
                    components: [],
                    scope: "SALE_UNIT",
                  })
                }
                required
              >
                <option value="">選択してください</option>
                {review.snapshot.lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}（構成品の残り{" "}
                    {l.components.reduce((s, c) => s + c.quantity - c.processed, 0)}個）
                  </option>
                ))}
              </select>
              <span className="field-error">{fields.lineId}</span>
            </label>
            <label className="field">
              <span>返品の範囲</span>
              <select
                aria-label="返品の範囲"
                value={input.scope ?? "SALE_UNIT"}
                onChange={(e) => update({ scope: e.target.value as "SALE_UNIT" | "COMPONENTS" })}
              >
                <option value="SALE_UNIT" disabled={currentLine?.componentOnly}>
                  販売単位（セット）全体を返品
                </option>
                <option value="COMPONENTS">構成品ごとに数量を指定して返品</option>
              </select>
              <span className="field-error">{fields.scope}</span>
            </label>
            {currentLine?.componentOnly && (
              <p className="notice">
                構成品の一部を処理済みです。残りの数量を構成品ごとに指定してください。
              </p>
            )}
            {input.scope === "COMPONENTS" ? (
              <>
                <p>
                  今回処理する数量だけ入力してください。未入力の構成品は返品しません。良品だけが販売可能在庫へ戻ります。
                </p>
                {currentLine?.components.map((c) => (
                  <section className="card form-stack" key={c.key}>
                    <h3>{c.label}</h3>
                    <p>
                      販売時 {c.quantity}個・処理済み {c.processed}個・残り{" "}
                      {c.quantity - c.processed}個／元の場所 {c.location}
                    </p>
                    {Object.entries(dispositionNames).map(([d, name]) => (
                      <label className="field" key={d}>
                        <span>{name}の数量</span>
                        <input
                          aria-label={`${c.label}の${name}の数量`}
                          type="number"
                          min="0"
                          max={c.quantity - c.processed}
                          value={
                            input.components?.find((r) => r.key === c.key && r.disposition === d)
                              ?.quantity ?? ""
                          }
                          onChange={(e) =>
                            update({
                              components: [
                                ...(input.components ?? []).filter(
                                  (r) => r.key !== c.key || r.disposition !== d,
                                ),
                                ...(e.target.value === ""
                                  ? []
                                  : [
                                      {
                                        key: c.key,
                                        disposition: d as "RESTOCK" | "DEFECTIVE" | "DISPOSED",
                                        quantity: e.target.value,
                                      },
                                    ]),
                              ],
                            })
                          }
                        />
                      </label>
                    ))}
                  </section>
                ))}
                <span className="field-error">
                  {fields.components ?? fields["input.components"]}
                </span>
              </>
            ) : (
              <>
                <label className="field">
                  <span>返品する販売単位数（セット数）</span>
                  <input
                    aria-label="返品する販売単位数（セット数）"
                    type="number"
                    min="1"
                    value={input.quantity}
                    onChange={(e) => update({ quantity: e.target.value })}
                    required
                  />
                  <span className="field-error">{fields.quantity ?? fields["input.quantity"]}</span>
                </label>
                {currentLine?.components.map((c) => (
                  <label className="field" key={c.key}>
                    <span>{c.label}の処理</span>
                    <span>
                      販売時 {c.quantity}個・処理済み {c.processed}個／元の場所 {c.location}
                    </span>
                    <select
                      aria-label={`${c.label}の処理`}
                      value={input.dispositions[c.key] ?? ""}
                      onChange={(e) =>
                        update({
                          dispositions: {
                            ...input.dispositions,
                            [c.key]: e.target.value as ReturnInput["dispositions"][string],
                          },
                        })
                      }
                      required
                    >
                      <option value="">現物の処理を選択してください</option>
                      {Object.entries(dispositionNames).map(([key, name]) => (
                        <option key={key} value={key}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <span className="field-error">{fields[`dispositions.${c.key}`]}</span>
                  </label>
                ))}
              </>
            )}
          </>
        )}
        {returnMoneyKeys.map((k) => (
          <section className="cost-field" key={k}>
            {props.compact ? (
              <label className="field">
                <span>{returnMoneyLabels[k]}（円）</span>
                <input
                  aria-label={`${returnMoneyLabels[k]}（円）`}
                  inputMode="numeric"
                  placeholder="未確認"
                  value={input[k].state === "NONE" ? "0" : input[k].amount}
                  onChange={(e) => {
                    const amount = e.target.value.replace(/[^\d]/g, "");
                    update({
                      [k]: {
                        state: amount === "" ? "UNKNOWN" : amount === "0" ? "NONE" : "AMOUNT",
                        amount,
                      },
                    });
                  }}
                />
              </label>
            ) : (
              <>
                <label className="field">
                  <span>{returnMoneyLabels[k]}の確認</span>
                  <select
                    aria-label={`${returnMoneyLabels[k]}の確認`}
                    value={input[k].state}
                    onChange={(e) =>
                      update({
                        [k]: {
                          ...input[k],
                          state: e.target.value as ReturnInput[typeof k]["state"],
                        },
                      })
                    }
                  >
                    <option value="UNKNOWN">未確認</option>
                    <option value="NONE">返金・返還なし（0円）</option>
                    <option value="AMOUNT">確認した金額を入力</option>
                  </select>
                </label>
                {input[k].state === "AMOUNT" && (
                  <label className="field">
                    <span>{returnMoneyLabels[k]}（円）</span>
                    <input
                      aria-label={`${returnMoneyLabels[k]}（円）`}
                      inputMode="numeric"
                      value={input[k].amount}
                      onChange={(e) => update({ [k]: { ...input[k], amount: e.target.value } })}
                      required
                    />
                  </label>
                )}
              </>
            )}
            <span className="field-error">{fields[k] ?? fields[`input.${k}`]}</span>
          </section>
        ))}
        <label className="field">
          <span>{input.kind === "REFUND" ? "返金・返還の理由" : "メモ（任意）"}</span>
          <textarea
            aria-label={input.kind === "REFUND" ? "返金・返還の理由" : "メモ（任意）"}
            maxLength={1000}
            required={input.kind === "REFUND"}
            value={input.memo}
            onChange={(e) => update({ memo: e.target.value })}
          />
          <span className="field-error">{fields.memo}</span>
        </label>
        {!!ownErrors.length && (
          <p className="notice">
            未確認・未入力の内容は途中保存できます。全項目の確認が済むまで、返品・返金・在庫を確定しません。
          </p>
        )}
        <button type="button" className="button secondary" onClick={() => void confirm()}>
          内容と在庫・損益を確認する
        </button>
        {preview?.valuation && previewInput === JSON.stringify(input) && (
          <section className="card form-stack" aria-label="在庫と原価への影響">
            <h2>在庫と原価への影響</h2>
            {(preview.valuation.requiresOrder || valuationPosition) && (
              <label className="field">
                <span>同日の計算順序</span>
                <select
                  aria-label="同日の計算順序"
                  aria-describedby="return-order-help"
                  value={valuationPosition}
                  onChange={(e) => setValuationPosition(e.target.value)}
                >
                  <option value="">原価・在庫が変わるため選択してください</option>
                  {preview.valuation.choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                <span id="return-order-help">
                  選択後に「内容と在庫・損益を確認する」を押してください。
                </span>
              </label>
            )}
            {preview.valuation.orderImpacts.map((impact, index) => (
              <div key={index}>
                <p>
                  {impact.name}（{impact.date}）
                </p>
                <p>
                  管理原価 {impact.beforeCost === null ? "未確認" : money(impact.beforeCost)} →{" "}
                  {impact.afterCost === null ? "未確認" : money(impact.afterCost)}
                </p>
                <p>
                  管理利益 {impact.beforeProfit === null ? "未確認" : money(impact.beforeProfit)} →{" "}
                  {impact.afterProfit === null ? "未確認" : money(impact.afterProfit)}
                </p>
              </div>
            ))}
            {preview.valuation.balances.map((balance) => (
              <p key={`${balance.variantId}:${balance.trackingMode}`}>
                記録後の管理残数 {balance.quantity}個／原価残高 {money(balance.before)} →{" "}
                {money(balance.after)}
              </p>
            ))}
            <p>{preview.valuation.changes.length}件の原価訂正。元の数量移動を再作成しません。</p>
          </section>
        )}
        {ready && (
          <section className="card form-stack" aria-label="返品・返金の確定内容">
            <h2>確定する内容</h2>
            <p>処理日 {input.date}</p>
            <p>
              {returnMoneyKeys
                .map((k) => `${returnMoneyLabels[k]} ${money(preview.amounts[k]!)}`)
                .join("・")}
            </p>
            <p>
              売上返金累計{" "}
              {money(
                (
                  BigInt(preview.snapshot.salesRefund) + BigInt(preview.amounts.salesRefund!)
                ).toString(),
              )}
              ／残り{" "}
              {money(
                (
                  BigInt(preview.snapshot.netSales) -
                  BigInt(preview.snapshot.salesRefund) -
                  BigInt(preview.amounts.salesRefund!)
                ).toString(),
              )}
            </p>
            {preview.changes.map((a, i) => (
              <p key={i}>
                {a.label}：{dispositionNames[a.disposition]} {a.quantity}個・原価 {money(a.cost)}／
                {a.location}
                {a.disposition === "RESTOCK"
                  ? "（販売可能在庫へ戻る）"
                  : "（販売可能数には戻らない）"}
              </p>
            ))}
            <p>
              記録後の管理利益：
              {preview.profit === null
                ? "計算に必要な費用・原価が未確認です"
                : money(preview.profit)}
            </p>
            <button className="button danger">
              {input.kind === "RETURN" ? "返品を記録する" : "在庫を変えずに返金を記録する"}
            </button>
          </section>
        )}
      </fieldset>
    </HydratedForm>
  );
}
