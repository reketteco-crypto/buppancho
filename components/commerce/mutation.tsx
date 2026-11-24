"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SharedValuationPreview } from "@/lib/inventory/shared-valuation";
import type { CommerceKind } from "@/lib/commerce/input";
import { createClientUuid as clientUuid } from "@/lib/client-uuid";
import { useClientReady } from "@/lib/use-client-ready";
import { FieldErrors, useDraftNavigation } from "./ui";
import { withInputReturn } from "@/lib/settings/return-path";

type Feedback = {
  status?: string;
  targetId?: string;
  id?: string;
  revision?: number;
  preview?: SharedValuationPreview;
  error?: string;
  code?: string;
  fields?: Record<string, string>;
  conflict?: DraftConflict;
};
type DraftConflict = {
  revision: number;
  archived: boolean;
  baseline: unknown;
  current: unknown;
  names: Record<string, string>;
};
type Context = {
  businessUnitId: string;
  operatorId: string;
  reportingEntityId?: string;
  year: number;
};
async function call(action: string, kind: string, payload: object): Promise<Feedback> {
  try {
    const response = await fetch("/api/commerce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, kind, payload }),
    });
    return (await response.json()) as Feedback;
  } catch {
    return { status: "UNKNOWN", error: "保存結果を確認してください。入力は保持しています。" };
  }
}
export function moneyLabel(value: string | bigint | null | undefined) {
  return value == null || value === "" ? "—" : `¥${BigInt(value).toLocaleString("ja-JP")}`;
}

export function useCostEstimate(payload: object, enabled: boolean) {
  const [refreshTick, setRefreshTick] = useState(0);
  const serialized = JSON.stringify({ ...payload, _refreshToken: refreshTick });
  type Estimate = {
    cost: string | null;
    final: boolean;
    materials?: {
      cost: string | null;
      final: boolean;
      quote: { settingId: string; unitCost: string; sourceLineId: string | null; final: boolean }[];
      uses: {
        settingId: string;
        name: string;
        quantity: string;
        unitCost: string;
        cost: string | null;
      }[];
    };
  };
  const [result, setResult] = useState<Estimate & { hash: string }>();
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/commerce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "estimate",
            kind: "SKU_SAVE",
            payload: JSON.parse(serialized),
          }),
        });
        const data = (await response.json()) as {
          estimate?: Estimate;
        };
        if (!disposed && data.estimate) setResult({ hash: serialized, ...data.estimate });
      } catch {
        /* An unavailable estimate never becomes a zero cost. */
      }
    }, 350);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [serialized, enabled]);
  return enabled && result?.hash === serialized
    ? { ...result, refresh: () => setRefreshTick((n) => n + 1) }
    : undefined;
}

export function useCommerceMutation(
  kind: CommerceKind,
  values: Record<string, unknown> & { context: Context },
  options?: { draftId: string; revision: number; kind: string; dirty: boolean },
  destination?: string,
) {
  const ready = useClientReady();
  const [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState<Feedback>({}),
    [preview, setPreview] = useState<SharedValuationPreview>();
  const [position, setPosition] = useState<string>();
  const [draftState, setDraftState] = useState("");
  const [savedSerialized, setSavedSerialized] = useState("");
  const [draftTick, setDraftTick] = useState(0);
  const [conflict, setConflict] = useState<DraftConflict>();
  const rebasePending = useRef<Record<string, unknown> | null>(null);
  const draftRevision = useRef(options?.revision ?? 0);
  const draftRunning = useRef<Promise<boolean> | null>(null);
  const draftPending = useRef<{ hash: string; payload: object } | null>(null);
  const savedHash = useRef("");
  const lastRequest = useRef<Record<string, unknown> | null>(null);
  const [previewHash, setPreviewHash] = useState("");
  const serialized = JSON.stringify(values);
  const draftBlocked = useRef(false);
  const valuesRef = useRef(values);
  useEffect(() => {
    valuesRef.current = values;
  }, [values]);
  const draftId = options?.draftId,
    draftKind = options?.kind;
  const frozen = ["UNKNOWN", "PROCESSING", "PREPARED", "APPLIED"].includes(feedback.status ?? "");
  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (!draftId || !draftKind || draftBlocked.current) return !draftBlocked.current;
    if (draftRunning.current) {
      const ok = await draftRunning.current;
      if (!ok) return false;
    }
    const current = valuesRef.current,
      hash = JSON.stringify(current);
    if (savedHash.current === hash) return true;
    const pending = draftPending.current ?? {
      hash,
      payload: {
        context: current.context,
        draftId,
        revision: draftRevision.current,
        requestKey: clientUuid(),
        values: current,
      },
    };
    draftPending.current = pending;
    setDraftState("保存中");
    const promise = (async () => {
      const result = await call("draft", draftKind, pending.payload);
      if (result.status === "SAVED" && result.revision !== undefined) {
        draftRevision.current = result.revision;
        savedHash.current = pending.hash;
        setSavedSerialized(pending.hash);
        draftPending.current = null;
        setDraftState("途中保存済み");
        const url = new URL(window.location.href);
        url.searchParams.set("draft", draftId);
        window.history.replaceState(null, "", url);
        return true;
      }
      setDraftState(result.error ?? "途中保存を確認できません");
      if (result.status === "REJECTED") {
        draftBlocked.current = true;
        setFeedback(result);
      }
      return false;
    })();
    draftRunning.current = promise;
    try {
      return await promise;
    } finally {
      draftRunning.current = null;
      setDraftTick((t) => t + 1);
    }
  }, [draftId, draftKind]);
  useEffect(() => {
    if (
      !options?.dirty ||
      busy ||
      frozen ||
      draftBlocked.current ||
      draftPending.current ||
      savedHash.current === serialized
    )
      return;
    const timer = setTimeout(() => {
      void saveDraft();
    }, 900);
    return () => clearTimeout(timer);
  }, [serialized, options?.dirty, busy, frozen, saveDraft, draftTick]);
  const flushForNavigation = useCallback(async () => {
    if (busy || frozen) {
      setDraftState("保存要求の結果を確認してから移動してください。");
      return false;
    }
    return saveDraft();
  }, [busy, frozen, saveDraft]);
  const allowNavigation = useDraftNavigation(
    !!options && ((!!options.dirty && serialized !== savedSerialized) || frozen || busy),
    flushForNavigation,
  );
  const goTo = useCallback(
    (href: string) => {
      allowNavigation();
      window.location.assign(href);
    },
    [allowNavigation],
  );
  const finish = useCallback(
    (id: string) => {
      const target =
        kind === "SUPPLIER_CONFIG"
          ? "/settings/suppliers"
          : kind === "ACCOUNT_SAVE" ||
              kind === "MONEY_RECORD" ||
              kind === "OTHER_RECORD" ||
              kind === "CATEGORY_SAVE"
            ? "/money"
            : kind === "BUY_CANCEL" ||
                kind === "BUY" ||
                kind === "RECEIVE" ||
                kind === "PURCHASE_RETURN" ||
                ((kind === "PURCHASE_COST" || kind === "PURCHASE_REFUND") &&
                  valuesRef.current.purchaseId)
              ? `/purchases/${id}`
              : ["DELIVERY", "PURCHASE_COST", "PURCHASE_REFUND", "PURCHASE_RETURN"].includes(kind)
                ? `/purchases/deliveries/${id}`
                : kind === "SALE" || kind === "MATERIAL_USE"
                  ? `/sales/orders/${id}`
                  : kind === "CHANNEL_SAVE" || kind === "DELIVERY_METHOD"
                    ? "/settings/sales-channels"
                    : kind === "SKU_BATCH" && lastRequest.current?.idempotencyKey
                      ? `/products?tab=skus&batch=${lastRequest.current.idempotencyKey}`
                      : kind === "SKU_SAVE"
                        ? `/products?tab=skus&focus=${id}`
                        : "/products?tab=skus";
      const returnTo = ["BUY", "SKU_SAVE", "SKU_BATCH", "CHANNEL_SAVE", "DELIVERY_METHOD"].includes(
        kind,
      )
        ? (new URL(window.location.href).searchParams.get("returnTo") ?? undefined)
        : undefined;
      goTo(destination ?? withInputReturn(target, returnTo));
    },
    [kind, destination, goTo],
  );
  const submit = async () => {
    if (busy || frozen) return;
    setBusy(true);
    setFeedback({});
    try {
      if (options && !(await saveDraft())) return;
      const payload: Record<string, unknown> = {
        ...valuesRef.current,
        idempotencyKey: clientUuid(),
        ...(options ? { draftId: options.draftId, draftRevision: draftRevision.current } : {}),
        ...(position ? { valuationPosition: position } : {}),
      };
      const hash = JSON.stringify({ values: valuesRef.current, position });
      if (
        [
          "BUY_CANCEL",
          "BUY",
          "RECEIVE",
          "SALE",
          "DELIVERY",
          "PURCHASE_COST",
          "PURCHASE_REFUND",
          "PURCHASE_RETURN",
        ].includes(kind)
      ) {
        if (preview && previewHash === hash && !preview.requiresOrder)
          payload.valuationFingerprint = preview.fingerprint;
        else {
          const result = await call("preview", kind, payload);
          if (!result.preview) {
            setFeedback(result);
            return;
          }
          setPreview(result.preview);
          setPreviewHash(hash);
          if (
            result.preview.requiresOrder ||
            result.preview.changes.length ||
            result.preview.orderImpacts.length ||
            result.preview.acquisitionImpacts?.length
          )
            return;
          payload.valuationFingerprint = result.preview.fingerprint;
        }
      }
      lastRequest.current = payload;
      const result = await call("save", kind, payload);
      setFeedback(result);
      if (result.status === "APPLIED" && result.targetId) finish(result.targetId);
    } finally {
      setBusy(false);
    }
  };
  const reviewDraft = async () => {
    if (!draftId || !draftKind || busy || frozen) return;
    setBusy(true);
    try {
      const result = await call("draft-review", draftKind, {
        context: valuesRef.current.context,
        draftId,
      });
      if (result.conflict) setConflict(result.conflict);
      else setFeedback(result);
    } finally {
      setBusy(false);
    }
  };
  const rebaseDraft = async (choice: "LOCAL" | "CURRENT") => {
    if (!draftId || !draftKind || !conflict || busy || frozen) return;
    setBusy(true);
    try {
      const payload = {
        context: valuesRef.current.context,
        idempotencyKey: clientUuid(),
        date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }),
        draftId,
        revision: conflict.revision,
        kind: draftKind,
        choice,
        values: valuesRef.current,
      };
      rebasePending.current = payload;
      lastRequest.current = payload;
      const result = await call("save", "DRAFT_REBASE", payload);
      setFeedback(result);
      if (result.status === "APPLIED" && result.targetId)
        goTo(`${kind === "BUY" ? "/purchases/new" : "/sales/new"}?draft=${result.targetId}`);
    } finally {
      setBusy(false);
    }
  };
  const recover = async (cancel = false) => {
    if (!lastRequest.current || busy) return;
    setBusy(true);
    try {
      const result = await call(cancel ? "cancel" : "result", kind, lastRequest.current);
      setFeedback(result);
      if (result.status === "APPLIED" && (result.id || result.targetId)) {
        if (rebasePending.current)
          goTo(
            `${kind === "BUY" ? "/purchases/new" : "/sales/new"}?draft=${result.id ?? result.targetId}`,
          );
        else finish((result.id ?? result.targetId)!);
      }
      if (["REJECTED", "CANCELLED"].includes(result.status ?? "")) lastRequest.current = null;
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    if (!lastRequest.current || feedback.status !== "PREPARED") return;
    setBusy(true);
    try {
      const result = await call(
        "save",
        rebasePending.current ? "DRAFT_REBASE" : kind,
        lastRequest.current,
      );
      setFeedback(result);
      if (result.status === "APPLIED" && result.targetId) {
        if (rebasePending.current)
          goTo(`${kind === "BUY" ? "/purchases/new" : "/sales/new"}?draft=${result.targetId}`);
        else finish(result.targetId);
      }
    } finally {
      setBusy(false);
    }
  };
  return {
    submit,
    ready,
    busy,
    frozen,
    feedback,
    preview: previewHash === JSON.stringify({ values, position }) ? preview : undefined,
    confirming:
      previewHash === JSON.stringify({ values, position }) &&
      !!preview &&
      !preview.requiresOrder &&
      (preview.changes.length > 0 ||
        preview.orderImpacts.length > 0 ||
        !!preview.acquisitionImpacts?.length),
    position,
    setPosition: (value: string) => {
      setPosition(value);
      setPreview(undefined);
    },
    recover,
    retry,
    draftState:
      options?.dirty &&
      serialized !== savedSerialized &&
      (draftState === "" || draftState === "途中保存済み")
        ? "未保存"
        : draftState,
    saveDraft,
    conflict,
    conflictLocal: values,
    reviewDraft,
    rebaseDraft,
    canReviewDraft: !!draftId && feedback.code === "CONFLICT",
  };
}

function draftSummary(value: unknown, names: Record<string, string>) {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const lines = Array.isArray(v.lines) ? (v.lines as Record<string, unknown>[]) : [];
  const charges = Array.isArray(v.charges) ? (v.charges as Record<string, unknown>[]) : [];
  const text = (x: unknown) => (typeof x === "string" || typeof x === "number" ? String(x) : "—");
  return {
    日付: text(v.date),
    取引先: text(v.supplierName),
    商品: lines.length
      ? lines.map((l) => `${text(l.name)} · ${text(l.quantity)}点 · ${text(l.amount)}`).join("\n")
      : (names[text(v.skuId)] ?? "—"),
    数量: text(v.quantity),
    商品代金: text(v.price),
    費用: charges.length
      ? charges.map((ch) => `${text(ch.name)} ${text(ch.amount)}`).join("\n")
      : `手数料 ${text(v.fee)} · 送料 ${text(v.shipping)}`,
    受取: typeof v.received === "boolean" ? (v.received ? "受取済み" : "受取待ち") : "—",
    メモ: text(v.memo),
  };
}
function DraftComparison({ conflict, local }: { conflict: DraftConflict; local: unknown }) {
  const baseline =
    conflict.baseline && typeof conflict.baseline === "object"
      ? (conflict.baseline as { values?: unknown }).values
      : undefined;
  const first = draftSummary(baseline, conflict.names),
    current = draftSummary(conflict.current, conflict.names),
    hand = draftSummary(local, conflict.names);
  return (
    <div>
      {Object.keys(current)
        .filter(
          (key) =>
            current[key as keyof typeof current] !== hand[key as keyof typeof hand] ||
            first[key as keyof typeof first] !== current[key as keyof typeof current],
        )
        .map((key) => (
          <div className="commerce-compare-group" key={key}>
            <h3>{key}</h3>
            <div className="commerce-compare-columns">
              {[
                ["入力開始時", baseline ? first[key as keyof typeof first] : "未保存"],
                ["別端末の保存", current[key as keyof typeof current]],
                ["手元の入力", hand[key as keyof typeof hand]],
              ].map(([label, value]) => (
                <div key={label}>
                  <span className="commerce-secondary">{label}</span>
                  <p>{value}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

export function MutationFeedback({
  mutation,
}: {
  mutation: ReturnType<typeof useCommerceMutation>;
}) {
  const { feedback, preview } = mutation;
  return (
    <>
      {feedback.error && (
        <div className="commerce-error" role="alert">
          <p>{feedback.error}</p>
          {feedback.fields && <FieldErrors fields={feedback.fields} />}
          {mutation.canReviewDraft && (
            <button
              type="button"
              className="button secondary"
              disabled={mutation.busy}
              onClick={() => void mutation.reviewDraft()}
            >
              保存内容と手元の入力を比較
            </button>
          )}
          {mutation.conflict && (
            <section className="commerce-impact">
              <h2>続ける内容を選択</h2>
              <DraftComparison conflict={mutation.conflict} local={mutation.conflictLocal} />
              {mutation.conflict.archived ? (
                <p className="commerce-caption">
                  元の入力は記録・選び直し済みです。元の記録を確認してください。
                </p>
              ) : (
                <div className="commerce-action-row">
                  <button
                    type="button"
                    className="button"
                    disabled={mutation.busy || mutation.frozen}
                    onClick={() => void mutation.rebaseDraft("LOCAL")}
                  >
                    手元の入力で続ける
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={mutation.busy || mutation.frozen}
                    onClick={() => void mutation.rebaseDraft("CURRENT")}
                  >
                    別端末の保存内容で続ける
                  </button>
                </div>
              )}
              <p className="commerce-caption">
                選び直しでは新しい途中保存を作成します。購入・販売・在庫は確定しません。
              </p>
            </section>
          )}
        </div>
      )}
      {mutation.frozen && (
        <div className="commerce-action-row">
          <button
            type="button"
            className="button secondary"
            onClick={() => void mutation.recover()}
          >
            保存結果を確認
          </button>
          {feedback.status === "PREPARED" && (
            <button type="button" className="button" onClick={() => void mutation.retry()}>
              同じ内容で再実行
            </button>
          )}
          <button
            type="button"
            className="commerce-text-button"
            onClick={() => void mutation.recover(true)}
          >
            未確定の要求を取り消す
          </button>
        </div>
      )}
      {preview &&
        (preview.requiresOrder ||
          preview.changes.length > 0 ||
          preview.orderImpacts.length > 0 ||
          !!preview.acquisitionImpacts?.length) && (
          <section className="commerce-impact" aria-label="原価への影響">
            <h2>原価への影響を確認</h2>
            {preview.acquisitionImpacts?.map((p, i) => (
              <div className="commerce-summary-line" key={`receipt:${i}`}>
                <span>
                  {p.date} · {p.name}
                  <small className="commerce-secondary">入庫原価</small>
                </span>
                <span>
                  {moneyLabel(p.before)} → {moneyLabel(p.after)}
                </span>
              </div>
            ))}
            {preview.requiresOrder && (
              <label className="field">
                同日の記録順序
                <select
                  value={mutation.position ?? ""}
                  onChange={(e) => mutation.setPosition(e.target.value)}
                >
                  <option value="">順序を選択</option>
                  {preview.choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {preview.orderImpacts.map((o, i) => (
              <div className="commerce-summary-line" key={i}>
                <span>
                  {o.date} · {o.name}
                </span>
                <span>
                  {moneyLabel(o.beforeCost)} → {moneyLabel(o.afterCost)}
                </span>
              </div>
            ))}
            {!preview.requiresOrder && (
              <div className="commerce-action-row">
                <p className="commerce-caption">
                  この内容で保存すると、表示した在庫・原価の変更を反映します。
                </p>
                <button
                  type="button"
                  className="button"
                  disabled={mutation.busy || mutation.frozen}
                  onClick={() => void mutation.submit()}
                >
                  この内容で保存
                </button>
              </div>
            )}
          </section>
        )}
    </>
  );
}
