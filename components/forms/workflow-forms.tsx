"use client";
import { createClientUuid } from "@/lib/client-uuid";

import { HydratedForm } from "@/components/forms/hydrated-form";
import { SavedSettingsLink } from "@/components/forms/saved-settings-link";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  saveWorkflowDraftAction,
  previewCompletionAction,
  previewListingEstimateAction,
  type ValuationPreview,
  type WorkflowResult,
  type WorkflowFeedback,
} from "@/app/sales/workflow-actions";
import { confirmedProfit } from "@/lib/validation/workflow";
import { sameDraftValue } from "@/lib/validation/draft-comparison";
import { workflowResult } from "@/lib/sales/workflow-result";
import { estimatedFee as feeFromRate } from "@/lib/sales/money";

export type InputContext = {
  businessUnitId: string;
  operatorId: string;
  year: number;
  reportingEntityId?: string;
};
export type ProductOption = {
  id: string;
  label: string;
  unique: boolean;
  available: number;
  cost: string | null;
};
type Part = {
  itemVariantId: string | null;
  uniqueStockUnitId: string | null;
  requiredQuantity: number;
};
export type ListingInput = {
  name: string;
  components: Part[];
  externalReference: string;
  price: string;
  listedDate: string;
  expectedShipping: string;
  expectedFeeSource?: "RATE" | "AMOUNT" | "UNKNOWN";
  expectedFee?: string;
  expectedPacking?: string;
  expectedOther?: string;
};
export type DraftInitial = { id: string; revision: number; persisted?: boolean };

// The browser keeps only an opaque draft ID in the URL. Business input stays on the server.
export function useWorkflowDraft(
  kind: "LISTING" | "PURCHASE" | "COMPLETION" | "RETURN" | "REFUND" | "LISTING_RETURN",
  initialContext: InputContext,
  payload: object,
  initial?: DraftInitial,
  enabled = true,
  baseSnapshot?:
    | import("@/lib/inventory/purchase-comparison").PurchaseBaseline
    | import("@/lib/sales/return-types").ReturnSnapshot
    | import("@/lib/sales/listing-return-input").ListingReturnSnapshot
    | import("@/lib/sales/input-origin").InputOrigin
    | null,
) {
  const [context] = useState(initialContext);
  const [id] = useState(() => initial?.id ?? createClientUuid());
  const revision = useRef(initial?.revision ?? 0),
    last = useRef(initial && initial.persisted !== false ? JSON.stringify(payload) : "");
  const [status, setStatus] = useState(
    initial && initial.persisted !== false ? "保存済み" : "未保存",
  );
  const [issue, setIssue] = useState<string>();
  const [draftVersion, setDraftVersion] = useState(initial?.revision ?? 0);
  const [savedPayload, setSavedPayload] = useState(
    initial && initial.persisted !== false ? JSON.stringify(payload) : "",
  );
  const inFlight = useRef(false);
  const paused = useRef(false);
  const saveFinished = useRef<Promise<void>>(Promise.resolve());
  const hasConflict = useRef(false);
  const receipt = useRef<{ requestId: string; serialized: string; revision: number } | null>(null);
  const [conflict, setConflict] = useState<{
    revision: number;
    remote: unknown;
    base: unknown;
  } | null>(null);
  const serialized = JSON.stringify(payload);
  const writeDraft = useCallback(
    (request: { requestId: string; serialized: string; revision: number }) =>
      saveWorkflowDraftAction({
        id,
        context,
        kind,
        requestId: request.requestId,
        revision: request.revision,
        payload: JSON.parse(request.serialized),
        ...(["LISTING", "PURCHASE", "RETURN", "REFUND", "LISTING_RETURN"].includes(kind)
          ? { baseSnapshot: baseSnapshot ?? null }
          : {}),
      }),
    [id, context, kind, baseSnapshot],
  );
  useEffect(() => {
    if (!enabled || conflict) return;
    let disposed = false;
    const timer = setInterval(async () => {
      if (
        disposed ||
        paused.current ||
        inFlight.current ||
        (!receipt.current && serialized === last.current)
      )
        return;
      if (!navigator.onLine) {
        setStatus("未保存・通信を確認中");
        return;
      }
      const request = receipt.current ?? {
        requestId: createClientUuid(),
        serialized,
        revision: revision.current,
      };
      receipt.current = request;
      inFlight.current = true;
      let finishSave!: () => void;
      saveFinished.current = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      setStatus("保存中");
      try {
        const result = await writeDraft(request);
        if (result.saved) {
          setIssue(undefined);
          revision.current = result.revision!;
          setDraftVersion(result.revision!);
          last.current = request.serialized;
          receipt.current = null;
          setSavedPayload(request.serialized);
          setStatus("保存済み");
          if (disposed) return;
          const url = new URL(window.location.href);
          if (url.searchParams.get("draft") !== id) {
            url.searchParams.set("draft", id);
            window.history.replaceState(null, "", url);
          }
        } else if (result.code === "CONFLICT" && result.revision !== undefined) {
          hasConflict.current = true;
          receipt.current = null;
          setConflict({
            revision: result.revision,
            remote: result.payload,
            base: last.current ? JSON.parse(last.current) : {},
          });
          setStatus("別端末との変更確認が必要");
        } else {
          setIssue(result.code);
          setStatus(result.error ?? "未保存");
        }
      } catch {
        setStatus("未保存・通信を確認中（確定操作は自動実行しません）");
      } finally {
        inFlight.current = false;
        finishSave();
      }
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [serialized, id, context, kind, enabled, conflict, baseSnapshot, writeDraft]);
  const restoreLatest = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("draft", id);
    window.location.assign(url);
  };
  const prepare = async (allowConflict = false) => {
    paused.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        saveFinished.current,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "途中保存の結果を確認中です。入力を保持して、保存結果が確認できてから確定してください。",
                ),
              ),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    // A comparison can pause autosave while an acknowledgement is missing.
    // Settle that exact draft request before issuing a new resolution request.
    if (allowConflict && receipt.current) {
      const request = receipt.current;
      const result = await writeDraft(request);
      if (result.saved) {
        revision.current = result.revision!;
        setDraftVersion(result.revision!);
        last.current = request.serialized;
        receipt.current = null;
        setSavedPayload(request.serialized);
        setStatus("保存済み");
        setIssue(undefined);
      } else if (result.code === "CONFLICT" && result.revision !== undefined) {
        receipt.current = null;
        hasConflict.current = true;
        setConflict({
          revision: result.revision,
          remote: result.payload,
          base: last.current ? JSON.parse(last.current) : {},
        });
        setStatus("別端末との変更確認が必要");
      } else {
        throw new Error(
          result.error ??
            "途中保存の結果をまだ確認できません。接続後に同じ操作の結果を確認してください。",
        );
      }
    }
    if (receipt.current || (hasConflict.current && !allowConflict))
      throw new Error(
        "途中保存の結果または別端末の変更を確認してから確定してください。入力は保持されています。",
      );
    return revision.current;
  };
  return {
    id,
    conflict,
    revision: draftVersion,
    issue,
    status: status === "保存済み" && serialized !== savedPayload ? "未保存" : status,
    prepare,
    flush: async () => {
      await prepare();
      if (last.current === serialized) return revision.current;
      const request = { requestId: createClientUuid(), serialized, revision: revision.current };
      receipt.current = request;
      setStatus("保存中");
      let result: WorkflowFeedback;
      try {
        result = await writeDraft(request);
      } catch {
        setStatus("未保存・通信を確認中（確定操作は自動実行しません）");
        throw new Error("途中保存の応答を確認できません。入力を保持しています。");
      }
      if (!result.saved) {
        setIssue(result.code);
        setStatus(result.error ?? "未保存");
        if (result.code === "CONFLICT" && result.revision !== undefined) {
          hasConflict.current = true;
          receipt.current = null;
          setConflict({
            revision: result.revision,
            remote: result.payload,
            base: last.current ? JSON.parse(last.current) : {},
          });
        } else if (result.status === "REJECTED") receipt.current = null;
        throw new Error(result.error ?? "途中保存の結果を確認してください。");
      }
      revision.current = result.revision!;
      setDraftVersion(result.revision!);
      last.current = serialized;
      receipt.current = null;
      setSavedPayload(serialized);
      setIssue(undefined);
      setStatus("保存済み");
      return result.revision!;
    },
    resume: () => {
      paused.current = false;
    },
    feedback: conflict ? (
      <section className="card message" role="alert">
        <h3>別端末の変更を確認してください</h3>
        <p>自動では上書きしません。商品・数量・日付・金額を確認して選択してください。</p>
        <DraftComparison base={conflict.base} remote={conflict.remote} current={payload} />
        <div className="button-row">
          <button type="button" className="button secondary" onClick={restoreLatest}>
            最新の保存内容を使う
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              revision.current = conflict.revision;
              setDraftVersion(conflict.revision);
              last.current = JSON.stringify(conflict.remote);
              receipt.current = null;
              hasConflict.current = false;
              setConflict(null);
              setStatus("手元の入力を引き継ぎました・未保存");
            }}
          >
            手元の入力を引き継いで再確認する
          </button>
        </div>
      </section>
    ) : null,
  };
}

function DraftComparison({
  base,
  remote,
  current,
}: {
  base: unknown;
  remote: unknown;
  current: unknown;
}) {
  const labels: Record<string, string> = {
    name: "商品・セット名",
    components: "構成商品と数量",
    price: "出品価格",
    listedDate: "出品日",
    externalReference: "出品URL・商品ID",
    money: "実売価格と費用",
    completedDate: "完了日",
    extra: "任意情報",
    date: "日付",
    supplierId: "仕入先",
    locationId: "保管場所",
    orderNumber: "注文番号",
    total: "仕入総額",
    memo: "メモ",
    lines: "明細",
    products: "作成商品",
    revision: "対象の更新版",
    context: "入力先",
    builder: "作成中の商品",
    actualPrice: "実売価格",
    fee: "販売手数料",
    shipping: "負担送料",
    packing: "梱包費",
    other: "その他費用",
  };
  const object = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const b = object(base),
    r = object(remote),
    l = object(current),
    show = (v: unknown) =>
      v == null ? "未入力" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return (
    <div className="form-stack">
      {[...new Set([...Object.keys(b), ...Object.keys(r), ...Object.keys(l)])]
        .filter((k) => !sameDraftValue(b[k], r[k]) || !sameDraftValue(r[k], l[k]))
        .map((k) => (
          <div className="card" key={k}>
            <strong>{labels[k] ?? k}</strong>
            <p style={{ overflowWrap: "anywhere" }}>入力開始時：{show(b[k])}</p>
            <p style={{ overflowWrap: "anywhere" }}>現在の保存：{show(r[k])}</p>
            <p style={{ overflowWrap: "anywhere" }}>手元の入力：{show(l[k])}</p>
          </div>
        ))}
    </div>
  );
}

function Feedback({ result, focus = false }: { result: WorkflowFeedback; focus?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus && result.error) heading.current?.focus();
  }, [focus, result.error]);
  return result.error ? (
    <div role="alert" className="message error">
      {focus && (
        <h2 ref={heading} tabIndex={-1}>
          入力・保存結果を確認してください
        </h2>
      )}
      {result.error}
      {result.fields && (
        <ul>
          {Object.entries(result.fields).map(([key, value]) => (
            <li key={key}>{value}</li>
          ))}
        </ul>
      )}
    </div>
  ) : null;
}
async function workflowFetch(url: string, body?: object): Promise<WorkflowResult> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return workflowResult(await response.json());
}
export function useSubmit(
  kind: import("@/lib/validation/workflow").WorkflowKind,
  initialContext: InputContext,
  destination: "listings" | "orders" | "draft" | "inventory" | "purchases" | "date-corrections",
) {
  const [context] = useState(initialContext);
  const key = useRef(createClientUuid());
  const [pending, setPending] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [saved, setSaved] = useState(false);
  const [result, setResult] = useState<WorkflowFeedback>({});
  const recovering = useRef(false);
  const markUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("operation", key.current);
    url.searchParams.set("operationKind", kind);
    window.history.replaceState(null, "", url);
  };
  const clearUrl = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("operation");
    url.searchParams.delete("operationKind");
    window.history.replaceState(null, "", url);
  };
  const draftUrl = (draftId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("operation");
    url.searchParams.delete("operationKind");
    url.searchParams.set("draft", draftId);
    return url.pathname + url.search;
  };
  const resultUrl = useCallback(
    (response: { id: string; recordId?: string }) => {
      const prefix =
        destination === "date-corrections"
          ? "/inventory/date-corrections"
          : destination === "inventory" || destination === "purchases"
            ? `/${destination}`
            : `/sales/${destination}`;
      const path = `${prefix}/${response.id}`;
      return response.recordId ? `${path}?return=${response.recordId}` : `${path}?recorded=1`;
    },
    [destination],
  );
  const finish = (response: WorkflowResult) => {
    setResult(response);
    if (response.saved && response.id) {
      setSaved(true);
      setUncertain(false);
      clearUrl();
      if (destination === "draft") {
        window.location.assign(draftUrl(response.id));
        return;
      }
      window.location.assign(resultUrl({ id: response.id, recordId: response.recordId }));
    } else if (response.status === "REJECTED" || response.status === "CANCELLED") {
      setUncertain(false);
      if (
        !kind.startsWith("PURCHASE_") &&
        ![
          "RETURN",
          "REFUND",
          "RETURN_REBASE",
          "DATE_CORRECT",
          "STOCKTAKE",
          "LISTING_RETURN",
          "LISTING_RETURN_CLOSE",
          "LISTING_RETURN_REBASE",
        ].includes(kind)
      )
        clearUrl();
      key.current = createClientUuid();
    } else setUncertain(true);
  };
  const lookup = async () => {
    setPending(true);
    try {
      finish(await workflowFetch(`/api/workflow-requests/${key.current}`));
    } catch {
      setResult({ error: "通信を確認中です。保存済みかどうかはまだ分かりません。" });
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    if (recovering.current) return;
    recovering.current = true;
    const url = new URL(window.location.href),
      id = url.searchParams.get("operation");
    if (url.searchParams.get("operationKind") !== kind || !id || !/^[a-f0-9-]{36}$/.test(id))
      return;
    key.current = id as `${string}-${string}-${string}-${string}-${string}`;
    queueMicrotask(() => setUncertain(true));
    void workflowFetch(`/api/workflow-requests/${id}`)
      .then((response) => {
        setResult(response);
        const terminal = response.status === "REJECTED" || response.status === "CANCELLED";
        setUncertain(!response.saved && !terminal);
        if (terminal) {
          const nextUrl = new URL(window.location.href);
          if (
            !kind.startsWith("PURCHASE_") &&
            ![
              "RETURN",
              "REFUND",
              "RETURN_REBASE",
              "DATE_CORRECT",
              "STOCKTAKE",
              "LISTING_RETURN",
              "LISTING_RETURN_CLOSE",
              "LISTING_RETURN_REBASE",
            ].includes(kind)
          ) {
            nextUrl.searchParams.delete("operation");
            nextUrl.searchParams.delete("operationKind");
          }
          window.history.replaceState(null, "", nextUrl);
          key.current = createClientUuid();
        }
        if (response.saved && response.id) {
          setSaved(true);
          if (destination === "draft") {
            window.location.assign(draftUrl(response.id));
            return;
          }
          window.location.assign(resultUrl({ id: response.id, recordId: response.recordId }));
        }
      })
      .catch(() =>
        setResult({ error: "保存結果をまだ確認できません。接続後に確認してください。" }),
      );
  }, [context, kind, destination, resultUrl]);
  const submit = async (payload: object | (() => Promise<object>)) => {
    if (pending || uncertain || saved) return;
    setPending(true);
    let sent = false;
    try {
      const resolved = typeof payload === "function" ? await payload() : payload;
      markUrl();
      sent = true;
      finish(
        await workflowFetch("/api/workflow", {
          kind,
          payload: { ...resolved, idempotencyKey: key.current, context },
        }),
      );
    } catch (error) {
      setUncertain(sent);
      setResult({
        error: sent
          ? "通信が途切れました。保存済みの可能性があります。保存結果を確認してください。"
          : error instanceof Error
            ? error.message
            : "途中保存を確認してから確定してください。",
      });
    } finally {
      setPending(false);
    }
  };
  const resolve = async (cancel: boolean) => {
    setPending(true);
    try {
      finish(
        await workflowFetch(`/api/workflow-requests/${key.current}`, {
          mode: cancel ? "cancel" : "resume",
          context,
        }),
      );
    } catch {
      setResult({ error: "通信を確認中です。操作を追加せず保存結果を確認してください。" });
    } finally {
      setPending(false);
    }
  };
  return {
    submit,
    pending: pending || uncertain || saved,
    result,
    feedback: (
      <>
        <Feedback result={result} focus />
        {uncertain && (
          <section className="message" aria-label="保存要求の確認">
            <p>
              {result.status === "PREPARED"
                ? "保存要求は保持済みです。業務更新はまだ確定していません。"
                : result.status === "PROCESSING"
                  ? "処理中です。結果を確認してください。"
                  : "保存状態を確認しています。完了を重ねて記録しないでください。"}
            </p>
            <button type="button" className="button secondary" disabled={pending} onClick={lookup}>
              保存結果を確認する
            </button>
            {result.status === "PREPARED" && (
              <button
                type="button"
                className="button"
                disabled={pending}
                onClick={() => void resolve(false)}
              >
                同じ保存要求を再実行する
              </button>
            )}
            {result.status !== "PROCESSING" && (
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => void resolve(true)}
              >
                未確定の要求を取り消して入力へ戻る
              </button>
            )}
            <p className="muted">
              再実行する内容はサーバーに保存した元の要求です。内容を変えるときは先に取り消してください。
            </p>
          </section>
        )}
      </>
    ),
  };
}

export function ListingRecordForm({
  options,
  context,
  today,
  initial,
  draft,
  feeRate,
  templates = [],
  baseline,
}: {
  options: ProductOption[];
  context: InputContext;
  today: string;
  initial?: ListingInput;
  draft?: DraftInitial;
  feeRate: string | null;
  templates?: { id: string; name: string; components: Part[] }[];
  baseline?: import("@/lib/sales/input-origin").InputOrigin | null;
}) {
  const [input, setInput] = useState<ListingInput>(
    initial ?? {
      name: "",
      components: [],
      externalReference: "",
      price: "",
      listedDate: today,
      expectedShipping: "",
      expectedFeeSource: "RATE",
      expectedFee: "",
      expectedPacking: "",
      expectedOther: "",
    },
  );
  const [search, setSearch] = useState("");
  const [origin] = useState(baseline ?? null);
  const [templateSearch, setTemplateSearch] = useState("");
  const [estimate, setEstimate] =
    useState<import("@/lib/sales/listing-estimate").ListingEstimate>();
  const [estimateKey, setEstimateKey] = useState("");
  const [estimateError, setEstimateError] = useState("");
  const [estimateFields, setEstimateFields] = useState<Record<string, string>>({});
  const [estimateTick, setEstimateTick] = useState(0);
  const calculationKey = JSON.stringify({
    context,
    components: input.components,
    price: input.price,
    expectedFeeSource: input.expectedFeeSource ?? "RATE",
    expectedFee: input.expectedFee ?? "",
    expectedShipping: input.expectedShipping,
    expectedPacking: input.expectedPacking ?? "",
    expectedOther: input.expectedOther ?? "",
  });
  useEffect(() => {
    let cancelled = false;
    if (!input.components.length) return;
    const timer = setTimeout(() => {
      void previewListingEstimateAction(JSON.parse(calculationKey))
        .then((result) => {
          if (cancelled) return;
          setEstimate(result.preview);
          setEstimateKey(calculationKey);
          setEstimateError(result.error ?? "");
          setEstimateFields(result.fields ?? {});
        })
        .catch(() => {
          if (!cancelled) {
            setEstimate(undefined);
            setEstimateError(
              "見込みを確認できません。入力を保持しています。接続後に見込みを再確認してください。",
            );
          }
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [calculationKey, estimateTick, input.components.length]);
  const estimateReady = estimate && estimateKey === calculationKey;
  const [bundle, setBundle] = useState(
    (initial?.components.length ?? 0) > 1 ||
      initial?.components.some((p) => p.requiredQuantity > 1) ||
      false,
  );
  const action = useSubmit("LIST", context, "listings");
  const autosave = useWorkflowDraft("LISTING", context, input, draft, !action.pending, origin);
  const field = (
    name: Exclude<keyof ListingInput, "components" | "expectedFeeSource">,
    label: string,
    type = "text",
    required = false,
  ) => (
    <label className="field">
      <span>
        {label}
        {required ? "（必須）" : ""}
      </span>
      <input
        type={type}
        required={required}
        value={input[name] ?? ""}
        onChange={(e) => setInput({ ...input, [name]: e.target.value })}
        inputMode={name === "price" || name.startsWith("expected") ? "numeric" : undefined}
      />
      <span className="field-error">{action.result.fields?.[name] ?? estimateFields[name]}</span>
    </label>
  );
  return (
    <HydratedForm
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!estimateReady || estimate.channelRevision === null) return;
        void action
          .submit(async () => ({
            ...input,
            channelRevision: estimate.channelRevision,
            baseSnapshot: origin,
            draftId: autosave.id,
            draftRevision: await autosave.prepare(),
          }))
          .finally(autosave.resume);
      }}
    >
      <p role="status" className="muted">
        {autosave.status}・準備中は在庫を確保しません
      </p>
      {autosave.feedback}
      <section className="card form-stack">
        <h2>1. 出品する商品</h2>
        {!!templates.length && (
          <details>
            <summary>保存したセット構成を使う</summary>
            <label className="field">
              <span>保存したセットを検索</span>
              <input
                type="search"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
              />
            </label>
            <div className="picker-results">
              {templates
                .filter((t) =>
                  t.name.toLocaleLowerCase().includes(templateSearch.toLocaleLowerCase()),
                )
                .slice(0, 30)
                .map((template) => (
                  <button
                    type="button"
                    className="picker-option"
                    key={template.id}
                    onClick={() => {
                      setBundle(true);
                      setInput({ ...input, name: template.name, components: template.components });
                    }}
                  >
                    <strong>{template.name}</strong>
                    <span>この構成を使う</span>
                  </button>
                ))}
            </div>
            <p className="muted">
              構成を選んでも在庫は確保しません。出品を記録する際に最新の在庫を確認します。
            </p>
          </details>
        )}
        <label className="field">
          <span>売り方</span>
          <select
            value={bundle ? "bundle" : "single"}
            onChange={(e) => {
              setBundle(e.target.value === "bundle");
              setInput({ ...input, components: [] });
            }}
          >
            <option value="single">単品</option>
            <option value="bundle">まとめ売り・セット</option>
          </select>
        </label>
        <label className="field">
          <span>商品名・色・サイズ・個体コードで検索</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="picker-results">
          {options
            .filter((v) => v.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
            .slice(0, 30)
            .map((option) => (
              <button
                key={option.id}
                type="button"
                className="picker-option"
                disabled={
                  !option.available ||
                  input.components.some(
                    (p) => (p.itemVariantId ?? p.uniqueStockUnitId) === option.id,
                  )
                }
                onClick={() => {
                  const part = {
                    itemVariantId: option.unique ? null : option.id,
                    uniqueStockUnitId: option.unique ? option.id : null,
                    requiredQuantity: 1,
                  };
                  setInput({
                    ...input,
                    name: input.name || option.label,
                    components: bundle ? [...input.components, part] : [part],
                  });
                }}
              >
                <strong>{option.label}</strong>
                <span>出品に使える {option.available}</span>
              </button>
            ))}
        </div>
        {input.components.map((part, index) => {
          const option = options.find(
            (o) => o.id === (part.itemVariantId ?? part.uniqueStockUnitId),
          );
          return (
            <div className="card form-stack" key={part.itemVariantId ?? part.uniqueStockUnitId}>
              <strong>{option?.label ?? "選択商品を確認してください"}</strong>
              {bundle && !part.uniqueStockUnitId && (
                <label className="field">
                  <span>この出品に含める数</span>
                  <input
                    type="number"
                    min="1"
                    max={option?.available}
                    value={part.requiredQuantity}
                    onChange={(e) =>
                      setInput({
                        ...input,
                        components: input.components.map((p, i) =>
                          i === index ? { ...p, requiredQuantity: Number(e.target.value) } : p,
                        ),
                      })
                    }
                  />
                </label>
              )}
              <span>
                確保する数：{part.requiredQuantity} ／ 出品に使える：{option?.available ?? 0}
              </span>
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  setInput({ ...input, components: input.components.filter((_, i) => i !== index) })
                }
              >
                選び直す
              </button>
            </div>
          );
        })}
        {field("name", bundle ? "セット名" : "出品の表示名", "text", true)}
      </section>
      <section className="card form-stack">
        <h2>2. メルカリに出品した情報</h2>
        <p className="muted">
          1つの商品IDを1つの販売単位として記録します。メルカリへの送信・自動取得は行いません。
        </p>
        {field("externalReference", "出品URLまたは商品ID", "text", true)}
        {field("price", "出品価格（円）", "text", true)}
        {field("listedDate", "出品日", "date", true)}
        <details>
          <summary>詳しい情報を追加</summary>
          <label className="field">
            <span>見込み手数料の計算</span>
            <select
              value={input.expectedFeeSource ?? "RATE"}
              onChange={(e) =>
                setInput({
                  ...input,
                  expectedFeeSource: e.target.value as "RATE" | "AMOUNT" | "UNKNOWN",
                })
              }
            >
              <option value="RATE">設定した率から候補を計算</option>
              <option value="AMOUNT">見込み金額を入力</option>
              <option value="UNKNOWN">未確認</option>
            </select>
          </label>
          {input.expectedFeeSource === "AMOUNT" && field("expectedFee", "見込み手数料（円）")}
          {field("expectedShipping", "見込み送料（円）")}
          {field("expectedPacking", "見込み梱包費（円）")}
          {field("expectedOther", "見込みその他費用（円）")}
          <p className="muted">
            空欄は未確認です。費用がないことを確認した場合は0を入力してください。見込みを実費として自動確定しません。
          </p>
        </details>
      </section>
      <section className="card form-stack">
        <h2>3. 在庫への反映を確認</h2>
        <p>この出品用に上の商品を確保します。管理上の残数は、取引完了を記録するまで減りません。</p>
        <p>
          見込み管理原価：
          {!estimateReady || estimate.cost === null
            ? "計算に必要な情報が不足"
            : `¥${BigInt(estimate.cost).toLocaleString("ja-JP")}${estimate.final ? "" : "（暫定原価）"}`}
        </p>
        <p className="muted">
          手数料率{" "}
          {estimateReady
            ? estimate.feeRate === null
              ? "未設定"
              : `${estimate.feeRate}%`
            : feeRate === null
              ? "未設定"
              : `${feeRate}%`}
          。候補額は販路の実際の請求額を保証するものではありません。
        </p>
        {estimateReady && (
          <>
            <p>
              見込み手数料：
              {estimate.fee === null
                ? "未確認"
                : `¥${BigInt(estimate.fee).toLocaleString("ja-JP")}`}
            </p>
            <p>
              {estimate.profit === null
                ? `計算に必要な情報が不足：${estimate.missing.join("、")}`
                : `見込み利益：¥${BigInt(estimate.profit).toLocaleString("ja-JP")}${estimate.final ? "" : "（概算・暫定原価）"}`}
            </p>
          </>
        )}
        {estimateError && (
          <p role="alert" className="message error">
            {estimateError}
          </p>
        )}
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setEstimateKey("");
            setEstimateTick((n) => n + 1);
          }}
        >
          見込みを再確認する
        </button>
        {(estimateReady ? estimate.feeRate : feeRate) === null && (
          <SavedSettingsLink
            href="/settings/sales-channels"
            returnTo={`/sales/listings/new?draft=${autosave.id}`}
            prepare={autosave.flush}
            resume={autosave.resume}
          >
            販路の手数料率を確認・保存する
          </SavedSettingsLink>
        )}
        {action.feedback}
        <button
          className="button"
          disabled={
            action.pending ||
            !estimateReady ||
            estimate.feeRate === null ||
            !input.components.length
          }
        >
          出品を記録して在庫を確保
        </button>
      </section>
    </HydratedForm>
  );
}

export type AmountInput = {
  actualPrice: string;
  fee: string;
  shipping: string;
  packing: string;
  other: string;
};
function MoneyFields({
  input,
  setInput,
  fields,
  compact = false,
}: {
  input: AmountInput;
  setInput: (value: AmountInput) => void;
  fields?: Record<string, string>;
  compact?: boolean;
}) {
  return (
    <>
      <label className="field">
        <span>実際に売れた金額（円・必須）</span>
        <input
          required
          inputMode="numeric"
          value={input.actualPrice}
          onChange={(e) => setInput({ ...input, actualPrice: e.target.value })}
        />
        <span className="field-error">{fields?.actualPrice}</span>
      </label>
      {(
        [
          ["fee", "販売手数料"],
          ["shipping", "負担送料"],
          ["packing", "梱包費"],
          ["other", "その他費用"],
        ] as const
      )
        .filter(([key]) => !compact || !["packing", "other"].includes(key))
        .map(([key, label]) => (
          <div className="cost-field" key={key}>
            <label className="field">
              <span>{label}（円）</span>
              <input
                inputMode="numeric"
                placeholder="未確認"
                value={input[key]}
                onChange={(e) => setInput({ ...input, [key]: e.target.value })}
              />
            </label>
            <span className="field-error">{fields?.[key]}</span>
            {!compact && (
              <div className="button-row">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setInput({ ...input, [key]: "0" })}
                >
                  費用なし
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setInput({ ...input, [key]: "" })}
                >
                  未確認にする
                </button>
              </div>
            )}
            <span className="muted">
              {input[key] === ""
                ? "未確認：0円にはしません"
                : input[key] === "0"
                  ? "費用なしとして確認"
                  : "入力額を確認済みとして保存"}
            </span>
          </div>
        ))}
    </>
  );
}

export type CompletionDraftInput = {
  listingId: string;
  revision: number;
  completedDate: string;
  valuationPosition?: string;
  money: AmountInput;
  extra: {
    purchasedDate: string;
    shippedDate: string;
    shippingMethod: string;
    trackingNumber: string;
    externalOrderId: string;
    memo: string;
  };
};
export function CompletionRecordForm({
  context,
  listingId,
  revision,
  price,
  today,
  cogs,
  estimatedFee,
  estimatedShipping,
  estimatedPacking = null,
  estimatedOther = null,
  estimateFeeRate = null,
  restored,
  draft,
}: {
  context: InputContext;
  listingId: string;
  revision: number;
  price: string;
  today: string;
  cogs: string | null;
  estimatedFee: string | null;
  estimatedShipping: string | null;
  estimatedPacking?: string | null;
  estimatedOther?: string | null;
  estimateFeeRate?: string | null;
  restored?: CompletionDraftInput;
  draft?: DraftInitial;
}) {
  const [money, setMoney] = useState<AmountInput>(
    restored?.money ?? {
      actualPrice: price,
      fee: "",
      shipping: "",
      packing: "",
      other: "",
    },
  );
  const [completedDate, setDate] = useState(restored?.completedDate ?? today);
  const feeCandidate =
    estimateFeeRate !== null && /^(0|[1-9]\d{0,14})$/.test(money.actualPrice)
      ? feeFromRate(BigInt(money.actualPrice), estimateFeeRate).toString()
      : estimatedFee;
  const [position, setPosition] = useState(restored?.valuationPosition ?? "");
  const [preview, setPreview] = useState<ValuationPreview>();
  const [previewInput, setPreviewInput] = useState("");
  const [previewError, setPreviewError] = useState<WorkflowFeedback>({});
  const [previewTick, setPreviewTick] = useState(0);
  const yearAction = useSubmit("YEAR_SWITCH", context, "draft");
  const switching = yearAction.pending;
  const [extra, setExtra] = useState(
    restored?.extra ?? {
      purchasedDate: "",
      shippedDate: "",
      shippingMethod: "",
      trackingNumber: "",
      externalOrderId: "",
      memo: "",
    },
  );
  const action = useSubmit("COMPLETE", context, "orders");
  const autosave = useWorkflowDraft(
    "COMPLETION",
    context,
    { listingId, revision, completedDate, money, extra, valuationPosition: position },
    draft,
    !action.pending && !switching,
  );
  const wrongYear = Number(completedDate.slice(0, 4)) !== context.year;
  const calculationInput = JSON.stringify({
    context,
    listingId,
    revision,
    completedDate,
    ...money,
    ...extra,
    ...(position ? { valuationPosition: position } : {}),
  });
  useEffect(() => {
    if (wrongYear || action.pending) return;
    let stopped = false;
    const timer = setTimeout(() => {
      void previewCompletionAction({
        ...JSON.parse(calculationInput),
        idempotencyKey: createClientUuid(),
      })
        .then((result) => {
          if (stopped) return;
          setPreview(result.preview);
          setPreviewError(result);
          setPreviewInput(calculationInput);
        })
        .catch(() => {
          if (!stopped) {
            setPreview(undefined);
            setPreviewError({
              error: "原価確認の通信が途切れました。入力を保持して再計算できます。",
            });
            setPreviewInput(calculationInput);
          }
        });
    }, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [calculationInput, wrongYear, action.pending, previewTick]);
  const ready =
    previewInput === calculationInput && !!preview && !preview.requiresOrder && !wrongYear;
  const profit = /^\d+$/.test(money.actualPrice)
    ? confirmedProfit({
        revenue: BigInt(money.actualPrice),
        costs: [money.fee, money.shipping, money.packing, money.other].map((v) =>
          /^\d+$/.test(v) ? BigInt(v) : null,
        ),
        cogs: ready && preview ? BigInt(preview.cost) : null,
        finalCost: preview?.final ?? false,
      })
    : null;
  return (
    <HydratedForm
      className="card form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || !preview) return;
        void action
          .submit(async () => ({
            listingId,
            revision,
            completedDate,
            ...money,
            ...extra,
            draftId: autosave.id,
            draftRevision: await autosave.prepare(),
            valuationFingerprint: preview.fingerprint,
            ...(position ? { valuationPosition: position } : {}),
          }))
          .finally(autosave.resume);
      }}
    >
      <h2>取引完了を記録</h2>
      <p role="status" className="muted">
        {autosave.status}・途中保存では在庫は変わりません
      </p>
      {autosave.feedback}
      <p>メルカリで取引が完了したことを確認してください。購入時・発送時の入力は不要です。</p>
      <label className="field">
        <span>完了日（日本時間・必須）</span>
        <input
          type="date"
          required
          value={completedDate}
          onChange={(e) => {
            setDate(e.target.value);
            setPosition("");
          }}
        />
      </label>
      {wrongYear && (
        <section className="message">
          <p>
            完了日は選択中の{context.year}
            年度と異なります。入力者・部門・入力内容を保持して切り替えます。切替だけでは完了しません。
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={action.pending || switching}
            onClick={() => {
              void yearAction
                .submit(async () => ({
                  draftId: autosave.id,
                  draftRevision: await autosave.prepare(),
                  listingId,
                  targetDate: completedDate,
                  payload: {
                    listingId,
                    revision,
                    completedDate,
                    money,
                    extra,
                    valuationPosition: position,
                  },
                }))
                .finally(autosave.resume);
            }}
          >
            {completedDate.slice(0, 4)}年度へ切り替えて続ける
          </button>
          <p>
            <Link href="/settings" target="_blank">
              設定を別画面で確認する
            </Link>
            （設定後、この入力へ戻って切り替えてください）
          </p>
        </section>
      )}
      <MoneyFields
        input={money}
        setInput={setMoney}
        fields={{ ...action.result.fields, ...previewError.fields }}
      />
      <details>
        <summary>見込み費用を確認して使う</summary>
        <p>
          見込み手数料 {feeCandidate === null ? "未設定" : `¥${feeCandidate}`} ／ 見込み送料{" "}
          {estimatedShipping === null ? "未設定" : `¥${estimatedShipping}`}。
          実際の費用を確認してから使用してください。率からの手数料候補は実売価格で計算します。
        </p>
        <button
          className="button secondary"
          type="button"
          disabled={feeCandidate === null}
          onClick={() => {
            if (feeCandidate !== null) setMoney({ ...money, fee: feeCandidate });
          }}
        >
          手数料の候補額を確認した
        </button>
        {estimatedShipping !== null && (
          <button
            className="button secondary"
            type="button"
            onClick={() => setMoney({ ...money, shipping: estimatedShipping })}
          >
            送料の候補額を確認した
          </button>
        )}
        {estimatedPacking !== null && (
          <button
            className="button secondary"
            type="button"
            onClick={() => setMoney({ ...money, packing: estimatedPacking })}
          >
            梱包費の候補額を確認した
          </button>
        )}
        {estimatedOther !== null && (
          <button
            className="button secondary"
            type="button"
            onClick={() => setMoney({ ...money, other: estimatedOther })}
          >
            その他費用の候補額を確認した
          </button>
        )}
      </details>
      <details>
        <summary>購入日・発送情報・メモを追加（任意）</summary>
        {Object.entries({
          purchasedDate: "購入日",
          shippedDate: "発送日",
          shippingMethod: "配送方法",
          trackingNumber: "追跡番号",
          externalOrderId: "取引ID",
          memo: "メモ",
        }).map(([key, label]) => (
          <label className="field" key={key}>
            <span>{label}</span>
            <input
              type={key.endsWith("Date") ? "date" : "text"}
              value={extra[key as keyof typeof extra]}
              onChange={(e) => setExtra({ ...extra, [key]: e.target.value })}
            />
          </label>
        ))}
      </details>
      <div className="message">
        <p>出品に確保した構成商品を1回だけ出庫します。入力した完了日で原価を計算します。</p>
        <p>
          完了日の管理原価：
          {ready && preview
            ? `¥${preview.cost}${preview.final ? "" : "（暫定）"}`
            : "確認中"} ／{" "}
          {profit === null
            ? "計算に必要な情報が不足（完了・金額要確認として保存できます）"
            : `管理利益 ¥${profit.toLocaleString("ja-JP")}`}
        </p>
        <p className="muted">現在在庫からの参考原価：{cogs === null ? "未確認" : `¥${cogs}`}</p>
      </div>
      {previewInput === calculationInput &&
        preview?.choices.length !== 0 &&
        preview?.requiresOrder && (
          <label className="field">
            <span>同日の計算順序で原価・在庫が変わります。実際の前後関係を確認してください。</span>
            <select value={position} onChange={(e) => setPosition(e.target.value)}>
              <option value="">順序を選択</option>
              {preview.choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        )}
      {position && (
        <button type="button" className="button secondary" onClick={() => setPosition("")}>
          同日の計算順序を選び直す
        </button>
      )}
      {ready && preview && preview.changes.length > 0 && (
        <section className="message">
          <h3>後続の原価への影響（取引{preview.orderImpacts.length}件）</h3>
          <p>元の数量・原価記録は残し、原価訂正を追記します。後続の在庫は再出庫しません。</p>
          <p>
            対象期間：{preview.changes.map((x) => x.date).sort()[0]} ～{" "}
            {preview.changes
              .map((x) => x.date)
              .sort()
              .at(-1)}
          </p>
          {preview.orderImpacts.map((order) => (
            <div className="card" key={order.id}>
              <Link href={`/sales/orders/${order.id}`} target="_blank">
                {order.date}・{order.name}
              </Link>
              <p>
                管理原価：{order.beforeCost === null ? "未確認" : `¥${order.beforeCost}`} →{" "}
                {order.afterCost === null ? "未確認" : `¥${order.afterCost}`}
              </p>
              <p>
                返品反映後の管理利益：
                {order.beforeProfit === null
                  ? "必要な金額が未確認"
                  : `¥${order.beforeProfit}`} →{" "}
                {order.afterProfit === null ? "必要な金額・原価が未確認" : `¥${order.afterProfit}`}
              </p>
            </div>
          ))}
          <details>
            <summary>原価訂正の内訳（{preview.changes.length}記録）</summary>
            {preview.changes.map((change) => (
              <p key={`${change.type}:${change.id}`}>
                {change.date}・
                {change.type === "CONSUMPTION"
                  ? "販売原価"
                  : change.type === "DISPOSITION"
                    ? "返品原価"
                    : "在庫移動原価"}
                ：¥{change.before} → ¥{change.after}
                {change.orderId && (
                  <>
                    {" "}
                    <Link href={`/sales/orders/${change.orderId}`} target="_blank">
                      対象取引
                    </Link>
                  </>
                )}
              </p>
            ))}
          </details>
        </section>
      )}
      {ready &&
        preview &&
        preview.balances.map((balance) => (
          <p key={balance.variantId}>
            在庫原価残高 ¥{balance.before} → ¥{balance.after}（完了後{balance.quantity}個）
          </p>
        ))}
      <Feedback result={previewError} />
      {yearAction.feedback}
      {!wrongYear && (
        <button
          type="button"
          className="button secondary"
          disabled={action.pending}
          onClick={() => {
            setPreviewInput("");
            setPreviewTick((n) => n + 1);
          }}
        >
          最新の在庫で影響を再確認
        </button>
      )}
      {action.feedback}
      <button className="button" disabled={action.pending || switching || !ready}>
        {preview?.changes.length ? "影響を確認して完了を記録する" : "完了を記録する"}
      </button>
    </HydratedForm>
  );
}

export function ListingEventForm({
  context,
  listingId,
  revision,
  today,
  legacy,
  returnPending,
  reservations = [],
  legacyQuantity,
  externalId,
}: {
  context: InputContext;
  listingId: string;
  revision: number;
  today: string;
  legacy: boolean;
  returnPending: boolean;
  reservations?: Array<{ id: string; label: string; quantity: number }>;
  legacyQuantity?: number;
  externalId?: string | null;
}) {
  const [event, setEvent] = useState(
    legacy ? "MIGRATE" : returnPending ? "RETURN_RECEIVED" : "PAUSE",
  );
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(today);
  const [goods, setGoods] = useState(false);
  const [legacyCount, setLegacyCount] = useState("");
  const [reference, setReference] = useState(externalId ?? "");
  const [dispositions, setDispositions] = useState<Record<string, string>>({});
  const action = useSubmit("EVENT", context, "listings");
  return (
    <HydratedForm
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void action.submit({
          listingId,
          revision,
          event,
          reason,
          date,
          goodsInHand: goods,
          ...(legacy ? { legacyQuantity: Number(legacyCount), externalReference: reference } : {}),
          dispositions:
            event === "RETURN_RECEIVED"
              ? reservations.map((r) => ({
                  reservationId: r.id,
                  disposition: dispositions[r.id] ?? "",
                }))
              : [],
        });
      }}
    >
      {legacy && (
        <>
          <p className="message">
            旧方式の出品数量 {legacyQuantity}{" "}
            を、商品の構成数量へ自動変換しません。上に表示された構成商品の「1出品分」を確保します。実際の出品内容と一致することを確認してください。
          </p>
          <label className="field">
            <span>確認した旧出品数量を入力</span>
            <input
              required
              type="number"
              value={legacyCount}
              onChange={(e) => setLegacyCount(e.target.value)}
            />
          </label>
          <label className="field">
            <span>実際の出品URLまたは商品ID</span>
            <input required value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
        </>
      )}
      <label className="field">
        <span>起きたこと</span>
        <select value={event} onChange={(e) => setEvent(e.target.value)}>
          {legacy ? (
            <option value="MIGRATE">1出品と構成商品を確認して新方式へ移す</option>
          ) : returnPending ? (
            <option value="RETURN_RECEIVED">返送された構成品の状態を確認し、出品を終了する</option>
          ) : (
            <>
              <option value="PAUSE">一時停止した（確保は維持）</option>
              <option value="RESUME">現物とメルカリを確認し、同じ出品を再開した</option>
              <option value="END">商品が手元にあり、出品を終了した</option>
              <option value="RETURN_PENDING">発送後にキャンセル・返送待ち</option>
            </>
          )}
        </select>
      </label>
      {returnPending && (
        <p className="message">
          未返送で所在未確認の品があれば、保存せず返送確認待ちを維持してください。良品だけ出品に使える在庫へ戻します。
        </p>
      )}
      <label className="field">
        <span>出来事の日付</span>
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      {returnPending &&
        reservations.map((r) => (
          <span className="field" key={r.id}>
            {r.label} ×{r.quantity} の現物確認
            <select
              required
              aria-label={`${r.label} の現物確認`}
              value={dispositions[r.id] ?? ""}
              onChange={(e) => setDispositions({ ...dispositions, [r.id]: e.target.value })}
            >
              <option value="">現物の状態を選択</option>
              <option value="RESTOCK">良品が手元に戻った</option>
              <option value="DEFECTIVE">不良品が戻った（販売不可）</option>
              <option value="DISPOSED">戻った商品を廃棄した</option>
              <option value="LOST">返送不要・紛失など、在庫へ戻さない</option>
            </select>
          </span>
        ))}
      <label className="field">
        <span>理由・確認内容（必須）</span>
        <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={goods} onChange={(e) => setGoods(e.target.checked)} />
        構成商品すべての現物が手元にあることを確認した
      </label>
      {action.feedback}
      <button className="button secondary" disabled={action.pending}>
        {legacy ? "対応を確認して在庫を確保" : "出来事を記録する"}
      </button>
    </HydratedForm>
  );
}

export function PriceRecordForm({
  context,
  listingId,
  revision,
  today,
}: {
  context: InputContext;
  listingId: string;
  revision: number;
  today: string;
}) {
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const action = useSubmit("PRICE", context, "listings");
  return (
    <HydratedForm
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void action.submit({ listingId, revision, date: today, price, reason });
      }}
    >
      <label className="field">
        <span>新価格（円）</span>
        <input
          required
          inputMode="numeric"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </label>
      <label className="field">
        <span>変更理由</span>
        <input required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {action.feedback}
      <button className="button" disabled={action.pending}>
        価格変更を記録する
      </button>
    </HydratedForm>
  );
}

export function RefundRecordForm({
  context,
  orderId,
  revision,
  today,
}: {
  context: InputContext;
  orderId: string;
  revision: number;
  today: string;
}) {
  const [money, setMoney] = useState({ salesRefund: "0", feeRefund: "0", shippingRefund: "0" });
  const [reason, setReason] = useState("");
  const action = useSubmit("REFUND", context, "orders");
  return (
    <HydratedForm
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void action.submit({ orderId, revision, date: today, reason, ...money });
      }}
    >
      <p>返金のみを記録します。商品の現物・数量・在庫は変更しません。</p>
      {(
        [
          ["salesRefund", "売上返金"],
          ["feeRefund", "手数料返還"],
          ["shippingRefund", "送料返還"],
        ] as const
      ).map(([key, label]) => (
        <label className="field" key={key}>
          <span>{label}（円）</span>
          <input
            required
            inputMode="numeric"
            value={money[key]}
            onChange={(e) => setMoney({ ...money, [key]: e.target.value })}
          />
        </label>
      ))}
      <label className="field">
        <span>返金・返還の理由</span>
        <input required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {action.feedback}
      <button className="button" disabled={action.pending}>
        在庫を変えずに返金を記録
      </button>
    </HydratedForm>
  );
}

export function AmountAmendForm({
  context,
  orderId,
  revision,
  initial,
  today,
  compact = false,
}: {
  context: InputContext;
  orderId: string;
  revision: number;
  initial: AmountInput;
  today: string;
  compact?: boolean;
}) {
  const [money, setMoney] = useState(initial);
  const [reason, setReason] = useState("");
  const action = useSubmit("AMEND", context, "orders");
  return (
    <HydratedForm
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void action.submit({ orderId, revision, date: today, reason, ...money });
      }}
    >
      {!compact && (
        <p>在庫は変更しません。変更前後と理由を履歴に残し、元の完了月の実績へ反映します。</p>
      )}
      <MoneyFields input={money} setInput={setMoney} compact={compact} />
      <label className="field">
        <span>補完・訂正の理由</span>
        <input required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {action.feedback}
      <button className="button" disabled={action.pending}>
        金額を補完・訂正する
      </button>
    </HydratedForm>
  );
}
