"use client";
import { useState } from "react";
import type { ImportCandidate } from "@/lib/commerce/imports/candidate";
import { useClientReady } from "@/lib/use-client-ready";
export function CandidateImport({
  onApply,
  kind,
  title = "ファイルから入力",
  chargesOnly = false,
  onChargesApply,
  initialOpen = false,
}: {
  onApply: (candidate: ImportCandidate) => void;
  kind: ImportCandidate["kind"];
  title?: string;
  chargesOnly?: boolean;
  onChargesApply?: (candidate: ImportCandidate) => void;
  initialOpen?: boolean;
}) {
  const ready = useClientReady();
  const [candidate, setCandidate] = useState<ImportCandidate>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const costCandidate = candidate && ["COST", "DELIVERY"].includes(candidate.kind);
  const canApplyCharges = costCandidate && candidate.charges.length > 0;
  const apply = (callback: (value: ImportCandidate) => void) => {
    if (!candidate) return;
    callback(candidate);
    setMessage("入力欄に反映しました。内容を確認して保存してください。");
    setCandidate(undefined);
  };
  return (
    <details
      className="commerce-disclosure commerce-import"
      data-candidate-import
      open={initialOpen || undefined}
    >
      <summary aria-disabled={!ready} tabIndex={ready ? 0 : -1}>
        {title}
      </summary>
      <label className="field">
        Excel・PDF
        <input
          type="file"
          accept=".xlsx,.pdf"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            e.target.value = "";
            setBusy(true);
            setError("");
            setCandidate(undefined);
            setMessage("");
            try {
              const { readImport } = await import("@/lib/commerce/imports/browser");
              setCandidate(await readImport(file));
            } catch (e) {
              setError(e instanceof Error ? e.message : "読み取れませんでした。");
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {busy && <p role="status">読み取り中…</p>}
      {message && (
        <p className="commerce-caption" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {candidate && (
        <div className="commerce-section">
          <h3>読み取った入力候補</h3>
          <p className="commerce-caption">{candidate.fileName}</p>
          {!chargesOnly &&
            candidate.kind === kind &&
            candidate.lines.map((l, i) => (
              <div className="commerce-summary-line" key={i}>
                <span>{l.name}</span>
                <span>
                  {l.quantity ?? "数量未確認"}点 · {l.amount ?? "金額未確認"} {candidate.currency}
                </span>
              </div>
            ))}
          {candidate.charges.map((ch, i) => (
            <div className="commerce-summary-line" key={i}>
              <span>{ch.name}</span>
              <span>
                {ch.amount ?? "未確認"} {ch.currency}
              </span>
            </div>
          ))}
          <p className="commerce-caption">
            {candidate.kind === "DELIVERY" && (chargesOnly || candidate.kind !== kind)
              ? "費用名・金額・通貨・配分方法を確認してください。"
              : candidate.unresolved.join(" ")}
          </p>
          {chargesOnly && canApplyCharges ? (
            <>
              <p className="commerce-caption">
                {kind === "COST"
                  ? "表示した費用を追加先へ反映します。"
                  : "表示した費用を購入全体へ配分します。"}
              </p>
              <button type="button" className="button secondary" onClick={() => apply(onApply)}>
                費用の入力欄に反映
              </button>
            </>
          ) : !chargesOnly && candidate.kind === kind ? (
            <button type="button" className="button secondary" onClick={() => apply(onApply)}>
              入力欄に反映
            </button>
          ) : canApplyCharges && onChargesApply ? (
            <>
              <p className="commerce-caption">
                {kind === "DELIVERY"
                  ? "表示した費用をこの配送へ配分します。"
                  : "表示した費用を購入全体へ配分します。配送ごとの配分は、購入保存後に「配送を追加」から登録できます。"}
              </p>
              <button
                type="button"
                className="button secondary"
                onClick={() => apply(onChargesApply)}
              >
                費用の入力欄に追加
              </button>
            </>
          ) : (
            <p className="commerce-caption">
              このファイルは
              {candidate.kind === "DELIVERY" ? "配送" : candidate.kind === "COST" ? "費用" : "購入"}
              の入力画面で使用してください。
            </p>
          )}
        </div>
      )}
    </details>
  );
}
