"use client";
import { useRef, useState } from "react";
import type { z } from "zod";
import type { deliverySchema } from "@/lib/commerce/input";
import { CostFields, blankCharge } from "./cost-fields";
import { MutationFeedback, useCommerceMutation } from "./mutation";
import { CandidateImport } from "./import-candidate";
import { ChargeGroup } from "./charge-group";
import type { ImportCandidate } from "@/lib/commerce/imports/candidate";

export function DeliveryEditor({
  initial,
  lines,
  methods,
  importOpen = false,
}: {
  initial: z.infer<typeof deliverySchema>;
  lines: {
    id: string;
    name: string;
    sourceName: string | null;
    purchase: string;
    reference: string;
    remaining: number;
    revision: number;
    receipts: { id: string; quantity: number; date: string }[];
  }[];
  methods: { id: string; name: string; revision: number; allocationMethod: string }[];
  importOpen?: boolean;
}) {
  const [values, setValues] = useState(initial),
    [importMessage, setImportMessage] = useState("");
  const selected = values.lines.filter((l) => l.quantity > 0);
  const mutation = useCommerceMutation("DELIVERY", {
    ...values,
    lines: selected,
    receiptLinks: values.receiptLinks.filter((r) => r.quantity > 0),
  });
  const change = (v: Partial<typeof values>) => setValues({ ...values, ...v });
  const costs = useRef<HTMLDetailsElement>(null);
  const importedCharges = (candidate: ImportCandidate) => [
    ...values.charges,
    ...candidate.charges.map((ch) => ({
      ...blankCharge(),
      name: ch.name,
      amount: ch.amount ?? "",
      currency: ch.currency,
    })),
  ];
  return (
    <form
      className="commerce-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void mutation.submit();
      }}
    >
      <fieldset
        className="commerce-fieldset"
        disabled={!mutation.ready || mutation.busy || mutation.frozen}
      >
        <CandidateImport
          kind="DELIVERY"
          title="配送明細・送料のファイルから入力"
          initialOpen={importOpen}
          onChargesApply={(candidate) => {
            change({ charges: importedCharges(candidate) });
            if (costs.current) costs.current.open = true;
          }}
          onApply={(candidate) => {
            const matches = candidate.lines.flatMap((row) => {
              const options = lines.filter(
                (l) =>
                  (l.name === row.name || l.sourceName === row.name) &&
                  (!row.sourceReference ||
                    l.reference === row.sourceReference ||
                    l.purchase.includes(row.sourceReference)),
              );
              return options.length === 1 && row.quantity
                ? [
                    {
                      lineId: options[0]!.id,
                      quantity: row.quantity,
                      purchaseRevision: options[0]!.revision,
                    },
                  ]
                : [];
            });
            change({
              reference: candidate.reference || values.reference,
              lines: [
                ...values.lines.filter((l) => !matches.some((r) => r.lineId === l.lineId)),
                ...matches,
              ],
              charges: importedCharges(candidate),
            });
            if (costs.current) costs.current.open = true;
            setImportMessage(
              `${candidate.lines.length}明細中${matches.length}明細を対応させました。数量・配送日を確認してください。`,
            );
          }}
        />
        {importMessage && (
          <p className="commerce-caption" role="status">
            {importMessage}
          </p>
        )}
        <div className="commerce-fields">
          <label className="field">
            配送日
            <input
              name="date"
              type="date"
              required
              value={values.date}
              onChange={(e) => change({ date: e.target.value })}
            />
          </label>
          <label className="field">
            配送方法
            <select
              name="deliveryMethodId"
              value={values.deliveryMethodId}
              onChange={(e) => {
                const m = methods.find((m) => m.id === e.target.value);
                change({ deliveryMethodId: m?.id || "", methodRevision: m?.revision });
              }}
            >
              <option value="">指定なし</option>
              {methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <section className="commerce-section">
          <h2>配送するもの</h2>
          {lines.map((l) => {
            const row = values.lines.find((r) => r.lineId === l.id);
            return (
              <div className="commerce-line-editor" key={l.id}>
                <div className="commerce-row">
                  <div>
                    <strong>{l.name}</strong>
                    <small className="commerce-secondary">
                      {l.purchase} · 未登録 {l.remaining}点
                    </small>
                  </div>
                  <label className="field">
                    数量
                    <input
                      aria-label={`${l.name}の配送数量`}
                      type="number"
                      min="0"
                      max={l.remaining}
                      value={row?.quantity || 0}
                      onChange={(e) =>
                        change({
                          lines: [
                            ...values.lines.filter((r) => r.lineId !== l.id),
                            {
                              lineId: l.id,
                              quantity: Number(e.target.value),
                              purchaseRevision: l.revision,
                            },
                          ],
                        })
                      }
                    />
                  </label>
                </div>
                {l.receipts.length > 0 && !!row?.quantity && (
                  <details className="commerce-disclosure">
                    <summary>受取済みの記録に紐づける</summary>
                    {l.receipts.map((r) => (
                      <label className="field" key={r.id}>
                        {r.date} 受取 {r.quantity}点
                        <input
                          type="number"
                          min="0"
                          max={Math.min(r.quantity, row.quantity)}
                          value={
                            values.receiptLinks.find((v) => v.receiptLineId === r.id)?.quantity || 0
                          }
                          onChange={(e) =>
                            change({
                              receiptLinks: [
                                ...values.receiptLinks.filter((v) => v.receiptLineId !== r.id),
                                {
                                  lineId: l.id,
                                  receiptLineId: r.id,
                                  quantity: Number(e.target.value),
                                },
                              ],
                            })
                          }
                        />
                      </label>
                    ))}
                  </details>
                )}
              </div>
            );
          })}
        </section>
        <details className="commerce-disclosure" ref={costs}>
          <summary>
            配送費用を追加
            <span>{values.charges.length ? `${values.charges.length}件` : "任意"}</span>
          </summary>
          {values.charges.map((ch, i) => (
            <ChargeGroup
              name={ch.name}
              key={i}
              onRemove={() => change({ charges: values.charges.filter((_, j) => i !== j) })}
            >
              <CostFields
                value={ch}
                onChange={(v) =>
                  change({ charges: values.charges.map((r, j) => (j === i ? { ...r, ...v } : r)) })
                }
                lines={lines.filter((l) => selected.some((r) => r.lineId === l.id))}
                bases={values.bases}
                onBasisChange={(bases) => change({ bases })}
              />
            </ChargeGroup>
          ))}
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              change({
                charges: [
                  ...values.charges,
                  {
                    ...blankCharge(),
                    method: (methods.find((m) => m.id === values.deliveryMethodId)
                      ?.allocationMethod || "VALUE") as ReturnType<typeof blankCharge>["method"],
                  },
                ],
              })
            }
          >
            費用を追加
          </button>
          {lines.some((l) => l.receipts.length > 0 && selected.some((r) => r.lineId === l.id)) && (
            <label className="field">
              後から追加する理由
              <input
                name="reason"
                value={values.reason}
                onChange={(e) => change({ reason: e.target.value })}
              />
            </label>
          )}
        </details>
        <details className="commerce-disclosure">
          <summary>伝票番号・メモ</summary>
          <label className="field">
            伝票番号
            <input
              name="reference"
              value={values.reference}
              onChange={(e) => change({ reference: e.target.value })}
            />
          </label>
          <label className="field">
            メモ
            <textarea
              name="memo"
              value={values.memo}
              onChange={(e) => change({ memo: e.target.value })}
            />
          </label>
        </details>
        <div className="commerce-save">
          <span>{selected.reduce((s, l) => s + l.quantity, 0)}点を配送</span>
          <button className="button" type="submit">
            配送を保存
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={mutation} />
    </form>
  );
}
