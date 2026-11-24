"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createClientUuid } from "@/lib/client-uuid";
import { useClientReady } from "@/lib/use-client-ready";
import type { ChannelOption, MethodOption, SkuOption } from "@/lib/commerce/view";
import { readSalesHistory, salesHistoryDate } from "@/lib/commerce/imports/sales-history";
import { SearchSelect, ContextHelp, useDraftNavigation } from "./ui";
import {
  emptySalesBatchRow,
  type SalesBatchData,
  type SalesBatchChanges,
  type SalesBatchMapping,
  type SalesBatchReview,
  type SalesBatchRow,
} from "@/lib/commerce/sales-batch-types";

type Context = {
  businessUnitId: string;
  operatorId: string;
  reportingEntityId?: string;
  year: number;
};
type Recovery = { index: number; key: string };
type Initial = {
  id: string;
  revision: number;
  data: SalesBatchData;
  review?: SalesBatchReview;
  recovery?: Recovery;
};
type Progress = { next: number; count: number; nextKey?: string; done: boolean };
type Result = { status: string; error?: string; id?: string };
class BatchError extends Error {
  constructor(
    message: string,
    public rejected: boolean,
    public code?: string,
  ) {
    super(message);
  }
}
const yen = (value: string | null) =>
  value === null ? "未確認" : `${BigInt(value).toLocaleString("ja-JP")}円`;

export function SalesBatchEditor({
  initial,
  context,
  skus,
  channels,
  methods,
  initialMappings,
}: {
  initial: Initial;
  context: Context;
  skus: SkuOption[];
  channels: ChannelOption[];
  methods: MethodOption[];
  initialMappings: SalesBatchMapping[];
}) {
  const router = useRouter();
  const ready = useClientReady();
  const [id] = useState(initial.id);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [revision, setRevision] = useState(initial.revision);
  const [rows, setRows] = useState(initial.data.rows);
  const [review, setReview] = useState(initial.review);
  const [recovery, setRecovery] = useState<Recovery | undefined>(initial.recovery);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [importNotice, setImportNotice] = useState("");
  const [mappings, setMappings] = useState(initialMappings);
  const [query, setQuery] = useState("");
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftError, setDraftError] = useState(false);
  const [savedHash, setSavedHash] = useState(JSON.stringify(initial.data.rows));
  const rowsRef = useRef(rows);
  const revisionRef = useRef(initial.revision);
  const runningDraft = useRef<Promise<number> | null>(null);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pendingDraft, setPendingDraft] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [forkReason, setForkReason] = useState("");
  const baseline = useRef(initial.data);
  const forkAttempt = useRef<{ key: string; data: object } | null>(null);
  const draftAttempt = useRef<{
    key: string;
    revision: number;
    data: SalesBatchData;
    wire: SalesBatchData | SalesBatchChanges;
  } | null>(null);
  const [bulk, setBulk] = useState({
    skuId: "",
    channelId: "",
    deliveryMethodId: "",
    date: "",
    quantity: "",
    fee: "",
    shipping: "",
    completed: false,
  });
  const frozen = !ready || busy || !!recovery || pendingDraft || !!forkAttempt.current;
  const editable = !frozen && !review;
  const productOptions = skus.map((s) => ({ id: s.id, label: `${s.name} · ${s.code}` }));
  function missing(row: SalesBatchRow) {
    return [
      !row.skuId && "販売商品",
      !row.channelId && "販路",
      !row.date && "完了日",
      !row.completed && "取引完了の確認",
      !(row.quantity > 0) && "数量",
      !/^\d+$/.test(row.price) && "金額",
    ].filter(Boolean) as string[];
  }
  const incompleteCount = rows.filter(
    (row) => !row.targetId && !row.excluded && missing(row).length,
  ).length;
  const serializedRows = JSON.stringify(rows);
  const unsaved = serializedRows !== savedHash;
  const autoSave = useEffectEvent(() => {
    void saveDraft().catch((error) => {
      setDraftError(true);
      errorMessage(error);
    });
  });
  useEffect(() => {
    if (
      !unsaved ||
      busy ||
      review ||
      recovery ||
      pendingDraft ||
      conflicted ||
      draftError ||
      savingDraft
    )
      return;
    const timer = setTimeout(() => autoSave(), 900);
    return () => clearTimeout(timer);
  }, [
    serializedRows,
    unsaved,
    busy,
    review,
    recovery,
    pendingDraft,
    conflicted,
    draftError,
    savingDraft,
  ]);
  const allowNavigation = useDraftNavigation(unsaved || pendingDraft || savingDraft, async () => {
    if (busy || recovery || conflicted) {
      setMessage("元の要求・競合を確認してから移動してください。手元の入力は保持しています。");
      return false;
    }
    try {
      return await saveDraft();
    } catch (error) {
      errorMessage(error);
      return false;
    }
  });
  const feedback =
    message ||
    (review?.id &&
    review.rows.length &&
    review.rows.every((p) => rows.some((r) => r.id === p.rowId && r.targetId))
      ? "選択した販売を保存しました。入金は記録していません。"
      : "");

  async function post<T>(action: string, args: object): Promise<T> {
    let response: Response;
    try {
      response = await fetch("/api/commerce/sales-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, context, id, ...args }),
      });
    } catch {
      throw new BatchError(
        "通信できませんでした。入力を保持しています。保存要求は先に結果を確認してください。",
        false,
      );
    }
    let body: { status: string; error?: string; code?: string; result?: T };
    try {
      body = await response.json();
    } catch {
      throw new BatchError("応答を確認できません。元の保存要求の結果を確認してください。", false);
    }
    if (response.ok && (action === "result" || action === "cancel")) return body as T;
    if (!response.ok || body.status === "REJECTED" || body.status === "UNKNOWN")
      throw new BatchError(
        body.error || "処理結果を確認してください。",
        body.status === "REJECTED",
        body.code,
      );
    return (action === "result" || action === "cancel" ? body : body.result) as T;
  }
  function errorMessage(error: unknown) {
    if (error instanceof BatchError && error.code === "CONFLICT") setConflicted(true);
    setMessage(
      error instanceof Error ? error.message : "入力を保持しています。再確認してください。",
    );
  }
  function patch(rowId: string, patch: Partial<SalesBatchRow>) {
    setRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
    setMessage("");
  }
  const matches = rows.filter((r) => {
    const date = r.date;
    return (
      `${r.sourceName} ${r.externalId} ${skus.find((s) => s.id === r.skuId)?.name || ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()) &&
      (!onlyIncomplete || (!r.targetId && !r.excluded && missing(r).length > 0)) &&
      (!from || date >= from) &&
      (!to || date <= to)
    );
  });
  const pages = Math.max(1, Math.ceil(matches.length / 50)),
    currentPage = Math.min(page, pages);
  const visible = matches.slice((currentPage - 1) * 50, currentPage * 50);
  const selected = rows.filter((r) => r.selected && !r.targetId && !r.excluded);
  const rowName = (rowId: string) => {
    const i = rows.findIndex((r) => r.id === rowId);
    return `${i + 1}行目 ${rows[i]?.sourceName || "手入力"}`;
  };

  async function saveDraft(): Promise<number> {
    if (runningDraft.current) await runningDraft.current;
    const current = rowsRef.current;
    if (!draftAttempt.current && JSON.stringify(current) === JSON.stringify(baseline.current.rows))
      return revisionRef.current;
    const old = new Map(baseline.current.rows.map((row) => [row.id, JSON.stringify(row)]));
    const attempt = draftAttempt.current ?? {
      key: createClientUuid(),
      revision: revisionRef.current,
      data: { rows: current },
      wire:
        revisionRef.current === 0
          ? { rows: current }
          : { changedRows: current.filter((row) => old.get(row.id) !== JSON.stringify(row)) },
    };
    draftAttempt.current = attempt;
    setSavingDraft(true);
    const request = (async () => {
      try {
        const saved = await post<{ revision: number }>("draft", {
          revision: attempt.revision,
          key: attempt.key,
          data: attempt.wire,
        });
        revisionRef.current = saved.revision;
        setRevision(saved.revision);
        baseline.current = attempt.data;
        setSavedHash(JSON.stringify(attempt.data.rows));
        setConflicted(false);
        setDraftError(false);
        draftAttempt.current = null;
        setPendingDraft(false);
        window.history.replaceState(null, "", `/sales/batch?draft=${id}`);
        return saved.revision;
      } catch (error) {
        if (error instanceof BatchError && error.rejected) draftAttempt.current = null;
        else setPendingDraft(true);
        throw error;
      } finally {
        setSavingDraft(false);
      }
    })();
    runningDraft.current = request;
    try {
      return await request;
    } finally {
      runningDraft.current = null;
    }
  }
  async function fork() {
    if (!forkAttempt.current)
      forkAttempt.current = {
        key: createClientUuid(),
        data: { revision, baseline: baseline.current, local: { rows }, reason: forkReason },
      };
    setBusy(true);
    try {
      const next = await post<{ id: string }>("fork", {
        key: forkAttempt.current.key,
        data: forkAttempt.current.data,
      });
      allowNavigation();
      router.push(`/sales/batch?draft=${next.id}`);
    } catch (error) {
      if (error instanceof BatchError && error.rejected) forkAttempt.current = null;
      errorMessage(error);
    } finally {
      setBusy(false);
    }
  }
  async function draftOnly() {
    setBusy(true);
    setMessage("");
    try {
      await saveDraft();
      setMessage("途中保存しました。販売・在庫は確定していません。");
    } catch (error) {
      errorMessage(error);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    setBusy(true);
    setMessage("");
    try {
      const savedRevision = await saveDraft();
      const result = await post<SalesBatchReview>("preview", { revision: savedRevision });
      setReview(result);
      if (result.issues.length)
        setMessage(
          "先行行で確認事項が見つかったため、後続の計算を止めました。対象行を補完するか選択から外し、再確認してください。",
        );
    } catch (error) {
      errorMessage(error);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const result = await post<Initial>("read", {});
    setRows(result.data.rows);
    baseline.current = result.data;
    setRevision(result.revision);
    revisionRef.current = result.revision;
    setSavedHash(JSON.stringify(result.data.rows));
    setReview(result.review);
    setRecovery(result.recovery);
  }
  async function saveSelected() {
    if (!review?.id) return;
    setBusy(true);
    setMessage("");
    try {
      let progress = await post<Progress>("progress", { id: review.id });
      while (!progress.done && progress.nextKey && active.current) {
        const current = { index: progress.next, key: progress.nextKey };
        setRecovery(current);
        const result = await post<{ targetId: string; rowId: string }>("save", {
          id: review.id,
          index: progress.next,
        });
        if (!active.current) return;
        setRows((rows) =>
          rows.map((r) => (r.id === result.rowId ? { ...r, targetId: result.targetId } : r)),
        );
        setRevision((r) => r + 1);
        progress = await post<Progress>("progress", { id: review.id });
        setRecovery(undefined);
      }
      await refresh();
      setRecovery(undefined);
      setMessage("選択した販売を保存しました。入金は記録していません。");
    } catch (error) {
      errorMessage(error);
    } finally {
      setBusy(false);
    }
  }
  async function resolve(cancel: boolean) {
    if (!recovery) return;
    setBusy(true);
    try {
      const result = await post<Result>(cancel ? "cancel" : "result", { id: recovery.key });
      if (result.status === "APPLIED") {
        await refresh();
        setRecovery(undefined);
        setReview(undefined);
        setMessage("元の販売は保存済みでした。残りの販売は、入力へ戻って確認し直してください。");
      } else if (result.status === "CANCELLED" || result.status === "REJECTED") {
        setRecovery(undefined);
        setReview(undefined);
        setMessage(
          result.error || "元の要求は終了しています。入力を確認し、残りを再確認してください。",
        );
      } else
        setMessage(
          result.status === "PROCESSING"
            ? "元の保存要求は処理中です。後続は保存していません。"
            : "元の要求の保存を確認できません。要求を取り消してから再確認してください。",
        );
    } catch (error) {
      errorMessage(error);
    } finally {
      setBusy(false);
    }
  }
  async function importCsv(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      if (file.size > 8000000) throw new Error("CSVは8MB以内に分けてください。");
      const imported = readSalesHistory(await file.text(), file.name, createClientUuid);
      if (rows.length + imported.length > 5000)
        throw new Error("1つの途中保存は5,000行以内に分けてください。");
      setRows([...rows, ...imported]);
      setImportNotice(`${imported.length}件追加・完了日は更新日から入力`);
    } catch (error) {
      errorMessage(error);
    } finally {
      setBusy(false);
    }
  }
  async function openPurchase() {
    setBusy(true);
    try {
      await saveDraft();
      allowNavigation();
      router.push(`/purchases/new?returnTo=${encodeURIComponent(`/sales/batch?draft=${id}`)}`);
    } catch (error) {
      errorMessage(error);
      setBusy(false);
    }
  }
  function applyBulk() {
    setRows((rows) =>
      rows.map((r) =>
        !r.selected || r.targetId || r.excluded
          ? r
          : {
              ...r,
              ...(bulk.skuId ? { skuId: bulk.skuId } : {}),
              ...(bulk.channelId ? { channelId: bulk.channelId } : {}),
              ...(bulk.deliveryMethodId ? { deliveryMethodId: bulk.deliveryMethodId } : {}),
              ...(bulk.date ? { date: bulk.date, position: "" as const } : {}),
              ...(bulk.quantity ? { quantity: Number(bulk.quantity) } : {}),
              ...(bulk.fee !== "" ? { fee: bulk.fee } : {}),
              ...(bulk.shipping !== "" ? { shipping: bulk.shipping } : {}),
              ...(bulk.completed ? { completed: true } : {}),
            },
      ),
    );
  }
  async function remember(row: SalesBatchRow) {
    setBusy(true);
    try {
      const mapping = await post<SalesBatchMapping>("mapping", {
        key: createClientUuid(),
        data: { sourceName: row.sourceName, channelId: row.channelId, skuId: row.skuId },
      });
      setMappings((v) => [
        ...v.filter(
          (m) => !(m.sourceName === mapping.sourceName && m.channelId === mapping.channelId),
        ),
        mapping,
      ]);
      setMessage("商品名と販売商品の対応を記憶しました。次回も候補として使えます。");
    } catch (error) {
      errorMessage(error);
    } finally {
      setBusy(false);
    }
  }
  const pagination = (label: string) => (
    <nav className="catalog-pagination" aria-label={label}>
      <span>
        {matches.length}件中 {visible.length ? (currentPage - 1) * 50 + 1 : 0}–
        {Math.min(currentPage * 50, matches.length)}件 · {currentPage}/{pages}ページ
      </span>
      <div>
        <button
          className="button secondary"
          type="button"
          disabled={currentPage === 1}
          onClick={() => setPage(currentPage - 1)}
        >
          前へ
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={currentPage === pages}
          onClick={() => setPage(currentPage + 1)}
        >
          次へ
        </button>
      </div>
    </nav>
  );

  return (
    <div className="sales-batch">
      <div className="sales-batch-progress" aria-label="入力の流れ">
        <span>
          <b>1</b> 追加
        </span>
        <span>
          <b>2</b> 内容を整える
        </span>
        <span>
          <b>3</b> 確認して記録
        </span>
        <span className="draft-indicator" role="status" aria-live="polite">
          {savingDraft
            ? "保存中…"
            : pendingDraft || draftError
              ? "途中保存を確認できません"
              : unsaved
                ? "未保存の変更あり"
                : revision
                  ? "途中保存済み"
                  : "入力は自動で途中保存されます"}
        </span>
      </div>
      {feedback && (
        <p role="status" className="commerce-note">
          {feedback}
        </p>
      )}
      {conflicted && !recovery && (
        <div className="commerce-note">
          <p>元の入力基準を保持しています。別画面の保存内容は自動で取り込みません。</p>
          <Link href={`/sales/batch?draft=${id}`} target="_blank" rel="noopener noreferrer">
            現在の保存内容を別画面で確認
          </Link>
          <label className="field">
            選び直す理由
            <input
              value={forkReason}
              disabled={busy || !!forkAttempt.current}
              onChange={(e) => setForkReason(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={busy || (!forkReason.trim() && !forkAttempt.current)}
            onClick={() => void fork()}
          >
            手元入力を新しい下書きに引き継ぐ
          </button>
        </div>
      )}
      {pendingDraft && (
        <button type="button" className="button" disabled={busy} onClick={() => void draftOnly()}>
          同じ内容で途中保存の結果を再確認
        </button>
      )}
      {recovery && (
        <div className="commerce-note sales-batch-recovery">
          <p>保存要求の結果を確認するまで、編集と後続保存を止めています。</p>
          <div className="commerce-action-row">
            <button className="button" disabled={busy} onClick={() => void resolve(false)}>
              元の保存結果を照会
            </button>
            <button className="button secondary" disabled={busy} onClick={() => void resolve(true)}>
              元の要求を取消・照会
            </button>
          </div>
        </div>
      )}
      <fieldset disabled={!editable} className="commerce-fieldset">
        <div className="commerce-toolbar sales-batch-add">
          <label className="button secondary file-button">
            ファイルから追加
            <input
              className="visually-hidden"
              aria-label="ファイルから追加"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                void importCsv(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={rows.length >= 5000}
            onClick={() => {
              const row = emptySalesBatchRow(createClientUuid());
              setRows([...rows, row]);
              setExpanded([row.id]);
              setQuery("");
              setFrom("");
              setTo("");
              setOnlyIncomplete(false);
              setPage(Math.ceil((rows.length + 1) / 50));
            }}
          >
            手入力の行を追加
          </button>
          {rows.length > 0 && (
            <>
              <input
                className="sales-batch-quick-search"
                type="search"
                aria-label="商品名・商品IDで絞り込む"
                placeholder="商品名・IDで検索"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
              />
              <details className="sales-batch-filter-options">
                <summary>日付・状態{from || to || onlyIncomplete ? "（絞込中）" : ""}</summary>
                <div className="commerce-toolbar">
                  {" "}
                  <label className="field">
                    完了日の開始
                    <input
                      type="date"
                      value={from}
                      onChange={(e) => {
                        setFrom(e.target.value);
                        setPage(1);
                      }}
                    />
                  </label>
                  <label className="field">
                    完了日の終了
                    <input
                      type="date"
                      value={to}
                      onChange={(e) => {
                        setTo(e.target.value);
                        setPage(1);
                      }}
                    />
                  </label>
                  <label className="commerce-checkbox">
                    <input
                      type="checkbox"
                      checked={onlyIncomplete}
                      onChange={(e) => {
                        setOnlyIncomplete(e.target.checked);
                        setPage(1);
                      }}
                    />
                    入力不足のみ
                  </label>
                </div>
              </details>
            </>
          )}
          <ContextHelp title="対応形式・入力のヒント">
            <p>
              対応形式：メルカリ販売CSV。更新日を完了日の初期値にします。保存前に取引の完了を確認してください。
            </p>
            <p>
              数量は販売する単位の数です。30枚セットなら、対応するセット商品を選び数量1とします。
            </p>
          </ContextHelp>
        </div>
        {selected.length > 0 && (
          <details className="commerce-disclosure sales-batch-bulk">
            <summary>選択行へまとめて設定（{selected.length}件）</summary>
            <div className="commerce-fields">
              <SearchSelect
                label="一括販売商品"
                value={bulk.skuId}
                options={productOptions}
                placeholder="変更しない"
                onChange={(skuId) => setBulk({ ...bulk, skuId })}
              />
              <label className="field">
                一括販路
                <select
                  value={bulk.channelId}
                  onChange={(e) => setBulk({ ...bulk, channelId: e.target.value })}
                >
                  <option value="">変更しない</option>
                  {channels.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                一括配送方法
                <select
                  value={bulk.deliveryMethodId}
                  onChange={(e) => setBulk({ ...bulk, deliveryMethodId: e.target.value })}
                >
                  <option value="">変更しない</option>
                  {methods.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                一括完了日
                <input
                  type="date"
                  value={bulk.date}
                  onChange={(e) => setBulk({ ...bulk, date: e.target.value })}
                />
              </label>
              <label className="field">
                一括数量
                <input
                  type="number"
                  min="1"
                  max="1000000"
                  value={bulk.quantity}
                  onChange={(e) => setBulk({ ...bulk, quantity: e.target.value })}
                />
              </label>
              <label className="field">
                一括手数料（円・空欄は変更なし）
                <input
                  inputMode="numeric"
                  value={bulk.fee}
                  onChange={(e) => setBulk({ ...bulk, fee: e.target.value })}
                />
              </label>
              <label className="field">
                一括送料（円・空欄は変更なし）
                <input
                  inputMode="numeric"
                  value={bulk.shipping}
                  onChange={(e) => setBulk({ ...bulk, shipping: e.target.value })}
                />
              </label>
              <label className="commerce-checkbox">
                <input
                  type="checkbox"
                  checked={bulk.completed}
                  onChange={(e) => setBulk({ ...bulk, completed: e.target.checked })}
                />
                選択行はすべて取引完了済みと確認した
              </label>
            </div>
            <div className="commerce-toolbar sales-batch-confirm-actions">
              <button type="button" className="button secondary" onClick={applyBulk}>
                選択行へ反映
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  setRows(
                    rows.map((r) => {
                      const m = mappings.find(
                        (m) => m.sourceName === r.sourceName.trim() && m.channelId === r.channelId,
                      );
                      return r.selected && !r.targetId && !r.excluded && !r.skuId && m
                        ? { ...r, skuId: m.skuId }
                        : r;
                    }),
                  )
                }
              >
                選択行に記憶した販売商品を反映
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  setRows(
                    rows.map((r) =>
                      r.selected && !r.targetId && !r.excluded && !r.date && r.source
                        ? { ...r, date: salesHistoryDate(r.source.updatedAt), position: "" }
                        : r,
                    ),
                  )
                }
              >
                空欄の完了日へ更新日を反映
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  setRows(
                    rows.map((r) =>
                      r.selected && !r.targetId ? { ...r, excluded: true, selected: false } : r,
                    ),
                  )
                }
              >
                選択行を対象外にする
              </button>
            </div>
            <p className="commerce-caption">
              全ページの選択中{selected.length}
              件が対象です。指定した項目だけを置き換えます。空欄は変更しません。
            </p>
          </details>
        )}
      </fieldset>
      <div className="sales-batch-counts">
        <span role="status">{importNotice}</span>
        <span>全{rows.length}件</span>
        <span>選択{selected.length}件</span>
        <span>入力不足{incompleteCount}件</span>
        <span>保存済み{rows.filter((r) => r.targetId).length}件</span>
        {rows.length > 0 && (
          <button
            type="button"
            className="commerce-text-button"
            disabled={!editable}
            onClick={() =>
              setRows(
                rows.map((r) =>
                  visible.some((v) => v.id === r.id) && !r.excluded && !r.targetId
                    ? { ...r, selected: true }
                    : r,
                ),
              )
            }
          >
            このページの未保存行を選択
          </button>
        )}
      </div>
      {pagination("上部の入力ページ送り")}
      {rows.length === 0 && (
        <div className="commerce-empty">
          <h2>販売履歴を追加しましょう</h2>
          <p>ファイルを読み込むか、手入力の行を追加して始めます。入力途中でも自動保存されます。</p>
        </div>
      )}
      {rows.length > 0 && (
        <div className="sales-batch-columns" aria-hidden="true">
          <span>選択</span>
          <span>商品・販売する商品</span>
          <span>完了日</span>
          <span>数量</span>
          <span>金額（円）</span>
          <span>状態</span>
          <span>詳細</span>
        </div>
      )}
      <div className="sales-batch-rows">
        {visible.map((row) => {
          const index = rows.indexOf(row) + 1;
          const label = (name: string) => `${index}行目の${name}`;
          const issue = review?.issues.find((i) => i.rowId === row.id);
          const absent = missing(row);
          const open = expanded.includes(row.id) || !!issue;
          const status = row.targetId
            ? "保存済み"
            : row.excluded
              ? "対象外"
              : issue
                ? "要確認"
                : absent.length
                  ? "入力不足"
                  : review?.rows.some((r) => r.rowId === row.id)
                    ? "確認済み"
                    : review && row.selected
                      ? "未評価"
                      : "確認待ち";
          return (
            <section
              className="sales-batch-row"
              data-expanded={open}
              key={row.id}
              id={`batch-row-${row.id}`}
              aria-label={`${index}行目`}
            >
              {row.targetId ? (
                <div className="sales-batch-saved">
                  <strong>
                    {index}行目 {row.sourceName || "手入力"}
                  </strong>
                  <span>
                    {row.date} · {row.quantity}点 ·{" "}
                    {row.priceBasis === "TOTAL" ? "販売金額" : "単価"} {yen(row.price)}
                  </span>
                  <Link href={`/sales/orders/${row.targetId}`}>保存済みの販売</Link>
                </div>
              ) : (
                <>
                  <fieldset className="commerce-fieldset" disabled={!editable}>
                    <div className="sales-batch-grid">
                      <label className="sales-batch-selection">
                        <input
                          type="checkbox"
                          disabled={row.excluded}
                          checked={row.selected}
                          onChange={(e) => patch(row.id, { selected: e.target.checked })}
                          aria-label={label("選択")}
                        />
                        <span className="visually-hidden">対象に選択</span>
                      </label>
                      <div className="sales-batch-product">
                        <span className="sales-batch-source" title={row.sourceName}>
                          {index}. {row.sourceName || "手入力"}
                        </span>
                        <SearchSelect
                          label="販売する商品"
                          placeholder="販売する商品を選択"
                          accessibleLabel={label("販売商品")}
                          value={row.skuId}
                          options={productOptions}
                          onChange={(skuId) => patch(row.id, { skuId, position: "" })}
                        />
                      </div>
                      <span className="sales-batch-mobile-summary">
                        {skus.find((s) => s.id === row.skuId)?.name || "販売商品を選んでください"} ·{" "}
                        {row.date || "完了日未入力"} · {row.price ? `${row.price}円` : "金額未入力"}
                      </span>
                      <label className="field batch-date">
                        <span>完了日</span>
                        <input
                          aria-label={label("完了日")}
                          type="date"
                          value={row.date}
                          onChange={(e) => patch(row.id, { date: e.target.value, position: "" })}
                        />
                      </label>
                      <label className="field batch-quantity">
                        <span>数量</span>
                        <input
                          aria-label={label("数量")}
                          type="number"
                          min="1"
                          max="1000000"
                          value={row.quantity || ""}
                          onChange={(e) =>
                            patch(row.id, { quantity: Number(e.target.value), position: "" })
                          }
                        />
                      </label>
                      <label className="field batch-price">
                        <span>{row.priceBasis === "TOTAL" ? "販売金額" : "商品単価"}（円）</span>
                        <input
                          aria-label={label("金額")}
                          inputMode="numeric"
                          value={row.price}
                          onChange={(e) => patch(row.id, { price: e.target.value })}
                        />
                      </label>
                      <button
                        type="button"
                        className={`commerce-badge batch-status ${absent.length || issue ? "pending" : ""}`}
                        aria-label={`${label("状態")}：${status}${absent.length ? `（${absent.join("・")}）` : ""}`}
                        onClick={() =>
                          setExpanded([...expanded.filter((id) => id !== row.id), row.id])
                        }
                      >
                        {status}
                      </button>
                      <button
                        type="button"
                        className="commerce-text-button"
                        aria-label={label("詳細")}
                        aria-expanded={open}
                        aria-controls={`batch-detail-${row.id}`}
                        onClick={() =>
                          setExpanded(
                            open ? expanded.filter((id) => id !== row.id) : [...expanded, row.id],
                          )
                        }
                      >
                        {open ? "閉じる" : "編集"}
                      </button>
                    </div>
                  </fieldset>
                  {open && absent.length > 0 && (
                    <p className="sales-batch-missing">
                      未入力：{absent.join("・")}
                      <button
                        className="commerce-text-button"
                        type="button"
                        onClick={() =>
                          setExpanded([...expanded.filter((id) => id !== row.id), row.id])
                        }
                      >
                        入力する
                      </button>
                    </p>
                  )}
                  {open && (
                    <div className="sales-batch-detail" id={`batch-detail-${row.id}`}>
                      {issue && (
                        <div role="alert">
                          <p>{issue.message}</p>
                          {issue.choices && (
                            <label className="field">
                              同日の計算順序
                              <select
                                aria-label={label("計算順序")}
                                value={row.position}
                                disabled={frozen}
                                onChange={(e) => {
                                  patch(row.id, { position: e.target.value });
                                  setReview(undefined);
                                }}
                              >
                                <option value="">選択してください</option>
                                {issue.choices.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                      )}
                      <fieldset className="commerce-fieldset" disabled={!editable}>
                        <div className="commerce-fields">
                          <label className="field">
                            元商品名
                            <input
                              aria-label={label("元商品名")}
                              value={row.sourceName}
                              readOnly={!!row.source}
                              onChange={(e) => patch(row.id, { sourceName: e.target.value })}
                            />
                          </label>
                          <label className="field">
                            販路
                            <select
                              aria-label={label("販路")}
                              value={row.channelId}
                              onChange={(e) => patch(row.id, { channelId: e.target.value })}
                            >
                              <option value="">選択してください</option>
                              {channels.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field">
                            金額の意味
                            <select
                              aria-label={label("金額の意味")}
                              value={row.priceBasis}
                              onChange={(e) =>
                                patch(row.id, { priceBasis: e.target.value as "UNIT" | "TOTAL" })
                              }
                            >
                              <option value="TOTAL">取引全体の金額</option>
                              <option value="UNIT">販売単位1点の単価</option>
                            </select>
                          </label>
                          <label className="field">
                            販売手数料（円）
                            <input
                              aria-label={label("手数料")}
                              inputMode="numeric"
                              placeholder="未確認"
                              value={row.fee}
                              onChange={(e) => patch(row.id, { fee: e.target.value })}
                            />
                          </label>
                          <label className="field">
                            配送料（円）
                            <input
                              aria-label={label("送料")}
                              inputMode="numeric"
                              placeholder="未確認"
                              value={row.shipping}
                              onChange={(e) => patch(row.id, { shipping: e.target.value })}
                            />
                          </label>
                        </div>
                        <div className="commerce-action-row">
                          <label className="commerce-checkbox">
                            <input
                              type="checkbox"
                              aria-label={label("取引完了済み")}
                              checked={row.completed}
                              onChange={(e) => patch(row.id, { completed: e.target.checked })}
                            />
                            取引完了済みを確認した
                          </label>
                          <label className="commerce-checkbox">
                            <input
                              type="checkbox"
                              aria-label={label("対象外")}
                              checked={row.excluded}
                              onChange={(e) =>
                                patch(row.id, { excluded: e.target.checked, selected: false })
                              }
                            />
                            私物販売等のため対象外
                          </label>
                        </div>
                        <details className="commerce-disclosure">
                          <summary>配送方法・商品ID・購入者・元データ</summary>
                          <div className="commerce-fields">
                            <label className="field">
                              配送方法
                              <select
                                aria-label={label("配送方法")}
                                value={row.deliveryMethodId}
                                onChange={(e) =>
                                  patch(row.id, { deliveryMethodId: e.target.value })
                                }
                              >
                                <option value="">未指定</option>
                                {methods.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="field">
                              商品ID
                              <input
                                aria-label={label("商品ID")}
                                value={row.externalId}
                                onChange={(e) => patch(row.id, { externalId: e.target.value })}
                              />
                            </label>
                            <label className="field">
                              購入者
                              <input
                                aria-label={label("購入者")}
                                value={row.buyer}
                                onChange={(e) => patch(row.id, { buyer: e.target.value })}
                              />
                            </label>
                            <label className="field">
                              メモ
                              <textarea
                                aria-label={label("メモ")}
                                value={row.memo}
                                onChange={(e) => patch(row.id, { memo: e.target.value })}
                              />
                            </label>
                          </div>
                          {row.source && (
                            <p className="commerce-caption">
                              元ファイル：{row.source.file}／購入日時：{row.source.purchasedAt}
                              ／更新日時：{row.source.updatedAt}／元の販売利益（商品原価控除前）：
                              {row.source.profit}円／参照：{row.source.url}
                            </p>
                          )}
                        </details>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!row.sourceName.trim() || !row.skuId || !row.channelId}
                          onClick={() => void remember(row)}
                        >
                          この商品名と販売商品の対応を記憶
                        </button>
                        {(!row.sourceName.trim() || !row.skuId || !row.channelId) && (
                          <p className="commerce-caption">
                            対応を記憶するには、元商品名・販売商品・販路を入力してください。
                          </p>
                        )}
                      </fieldset>
                    </div>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>
      {pagination("下部の入力ページ送り")}
      {review && (
        <section className="commerce-note" aria-label="販売の一括確認">
          <h2>在庫・原価・利益をまとめて確認</h2>
          <p>
            入庫・販売の出来事順に計算しています。後日、過去の入庫を追加した場合は、その登録時に原価への影響を確認します。
          </p>
          {review.rows.map((r) => (
            <div className="sales-batch-result" key={r.rowId}>
              <strong>
                {rowName(r.rowId)} · {r.date}
              </strong>
              <p>
                商品原価 {yen(r.cost)}／資材原価 {yen(r.materials)}／利益 {yen(r.profit)}
                {r.provisional ? "（原価は暫定）" : ""}
              </p>
              {r.balances.map((b) => (
                <p key={`${b.variantId}:${b.trackingMode}`}>
                  この行の反映後の在庫 {b.quantity}点 · 在庫原価 {yen(b.before)} → {yen(b.after)}
                </p>
              ))}
              {r.impacts.map((impact, i) => (
                <p key={i}>
                  既存販売への影響：{impact.name}（{impact.date}）原価 {yen(impact.beforeCost)} →{" "}
                  {yen(impact.afterCost)}／利益 {yen(impact.beforeProfit)} →{" "}
                  {yen(impact.afterProfit)}
                </p>
              ))}
            </div>
          ))}
          {review.issues.map((issue) => (
            <p key={issue.rowId} role="alert">
              <button
                className="commerce-text-button"
                type="button"
                onClick={() => {
                  setQuery("");
                  setFrom("");
                  setTo("");
                  setOnlyIncomplete(false);
                  setPage(Math.floor(rows.findIndex((r) => r.id === issue.rowId) / 50) + 1);
                  setExpanded([issue.rowId]);
                  requestAnimationFrame(() =>
                    document
                      .getElementById(`batch-row-${issue.rowId}`)
                      ?.scrollIntoView({ block: "center" }),
                  );
                }}
              >
                {rowName(issue.rowId)}：{issue.message}
              </button>
            </p>
          ))}
          {!recovery && (
            <div className="commerce-toolbar">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setReview(undefined);
                  setMessage("");
                }}
              >
                入力へ戻る
              </button>
              {review.id && rows.some((r) => r.selected && !r.targetId && !r.excluded) && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void saveSelected()}
                >
                  確認した販売を順次保存
                </button>
              )}
            </div>
          )}
        </section>
      )}
      {!review && (
        <div className={`commerce-toolbar ${selected.length ? "sales-batch-actions" : ""}`}>
          <button
            type="button"
            className="button secondary"
            disabled={frozen}
            onClick={() => void draftOnly()}
          >
            途中保存
          </button>
          <button
            type="button"
            className="button"
            disabled={frozen || !selected.length}
            onClick={() => void preview()}
          >
            選択行の在庫・原価を確認
          </button>
        </div>
      )}
      {!review && !selected.length && (
        <p className="commerce-caption">記録する行を選択すると、在庫・原価の確認へ進めます。</p>
      )}
      <button
        type="button"
        className="commerce-text-button"
        disabled={frozen}
        onClick={() => void openPurchase()}
      >
        途中保存して不足している購入・入庫を登録する
      </button>
    </div>
  );
}
