"use client";

import { PaymentAccount, usePaymentAccounts } from "./payment-fields";
import type { AccountChoice } from "./money-form";
import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { createClientUuid } from "@/lib/client-uuid";
import { calculatePurchase } from "@/lib/commerce/purchase-calculation";
import { ExchangeFields } from "./cost-fields";
import { CandidateImport } from "./import-candidate";
import { ChargeGroup } from "./charge-group";
import type { ImportCandidate } from "@/lib/commerce/imports/candidate";
import { allocationLabels, type AllocationMethod } from "@/lib/commerce/allocation";
import type { BuyInput } from "@/lib/commerce/input";
import { applyPurchaseChoice } from "@/lib/commerce/purchase-choice";
import { PurchaseProductPicker } from "./purchase-product-picker";
import { ContextHelp } from "./ui";
import { PurchaseCostSummary } from "./purchase-cost-summary";
import type { SupplyPrice } from "@/lib/commerce/supplies";
import { MutationFeedback, moneyLabel, useCommerceMutation } from "./mutation";

export function PurchaseEditor({
  initial,
  draftId,
  draftRevision,
  suppliers,
  locations,
  supplies = [],
  accounts: initialAccounts = [],
}: {
  initial: BuyInput;
  draftId: string;
  draftRevision: number;
  suppliers: {
    id: string;
    name: string;
    revision: number;
    currency?: string;
    allocation?: string;
  }[];
  locations: { id: string; name: string }[];
  supplies?: SupplyPrice[];
  accounts?: AccountChoice[];
}) {
  const paymentAccounts = usePaymentAccounts(initialAccounts, initial.context),
    accounts = paymentAccounts.accounts;
  const [values, setValues] = useState(initial),
    [dirty, setDirty] = useState(false),
    [exchangeOpen, setExchangeOpen] = useState(!!initial.currency && initial.currency !== "JPY");
  const productExchange = useRef<HTMLDetailsElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const change = (next: Partial<BuyInput>) => {
    setValues((v) => ({ ...v, ...next }));
    setDirty(true);
  };
  const costs = useRef<HTMLDetailsElement>(null);
  const applyCharges = (candidate: ImportCandidate) => {
    change({
      charges: [
        ...values.charges,
        ...candidate.charges.map((ch) => ({
          name: ch.name,
          amount: ch.amount ?? "",
          currency: ch.currency,
          method: "VALUE" as const,
          capitalized: true,
          lineIds: [],
          manual: {},
        })),
      ],
    });
    if (costs.current) costs.current.open = true;
  };
  const mutation = useCommerceMutation("BUY", values, {
    draftId,
    revision: draftRevision,
    kind: "COMMERCE_PURCHASE",
    dirty,
  });
  const lineChange = (index: number, next: Partial<BuyInput["lines"][number]>) =>
    change({ lines: values.lines.map((l, i) => (i === index ? { ...l, ...next } : l)) });
  let calculation: ReturnType<typeof calculatePurchase> | undefined;
  let calculationMessage = "";
  const incompleteIndex = values.lines.findIndex(
    (l) => !l.amount || !Number.isInteger(l.quantity) || l.quantity <= 0,
  );
  const missingProductRate =
    (values.currency || "JPY") !== "JPY" && !values.exchangeRate && !values.actualOrderJpy;
  try {
    if (incompleteIndex >= 0) {
      const line = values.lines[incompleteIndex]!;
      calculationMessage = `${line.name || `明細${incompleteIndex + 1}`}の${!Number.isInteger(line.quantity) || line.quantity <= 0 ? "数量" : line.priceBasis === "LINE" ? "明細金額" : "単価"}を入力してください。`;
    } else if (missingProductRate) {
      calculationMessage = `商品代金（${values.currency}）の換算レート、または購入全体の円建て金額を入力してください。`;
    } else calculation = calculatePurchase(values);
  } catch (error) {
    calculationMessage =
      error instanceof Error ? error.message : "商品金額・通貨・円換算レートを確認してください。";
  }
  return (
    <form
      ref={form}
      className="commerce-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void mutation.submit();
      }}
    >
      <fieldset
        disabled={!mutation.ready || mutation.busy || mutation.frozen}
        className="commerce-fieldset"
      >
        {values.lines.every((l) => !l.name && !l.amount) && (
          <CandidateImport
            kind="PURCHASE"
            onChargesApply={applyCharges}
            onApply={(candidate) => {
              setExchangeOpen((candidate.currency || "JPY") !== "JPY");
              change({
                date: candidate.date || values.date,
                currency: candidate.currency || "JPY",
                exchangeRate: candidate.exchangeRate || "",
                externalReference: candidate.reference || "",
                importSource: {
                  adapterId: candidate.adapterId,
                  fileName: candidate.fileName,
                  digest: candidate.digest,
                },
                lines: candidate.lines.map((l) => ({
                  clientId: createClientUuid(),
                  variantId: "",
                  name: l.name,
                  sourceName: l.name,
                  trackingMode: "QUANTITY",
                  quantity: l.quantity ?? 0,
                  amount: l.amount ?? "",
                  priceBasis: "UNIT",
                  weight: "",
                  volume: "",
                  condition: "",
                })),
                charges: [
                  ...values.charges,
                  ...candidate.charges.map((ch) => ({
                    name: ch.name,
                    amount: ch.amount ?? "",
                    currency: ch.currency,
                    method: "VALUE" as const,
                    capitalized: true,
                    lineIds: [],
                    manual: {},
                  })),
                ],
              });
            }}
          />
        )}
        <div className="commerce-fields">
          <label className="field">
            購入日
            <input
              name="date"
              type="date"
              required
              value={values.date}
              onChange={(e) => {
                change({ date: e.target.value, valuationPosition: undefined });
                mutation.setPosition("");
              }}
            />
          </label>
          <label className="field">
            取引先
            <input
              list="purchase-suppliers"
              required
              value={values.supplierName}
              onChange={(e) => {
                const supplier = suppliers.find((s) => s.name === e.target.value);
                if (
                  supplier?.currency &&
                  supplier.currency !== "JPY" &&
                  values.lines.every((l) => l.amount === "")
                )
                  setExchangeOpen(true);
                change({
                  supplierName: e.target.value,
                  supplierId: supplier?.id ?? "",
                  supplierRevision: supplier?.revision,
                  ...(supplier?.currency && values.lines.every((l) => l.amount === "")
                    ? { currency: supplier.currency, exchangeRate: "", actualOrderJpy: "" }
                    : {}),
                });
              }}
            />
            <datalist id="purchase-suppliers">
              {suppliers.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
          </label>
        </div>
        <details
          className="commerce-disclosure"
          ref={productExchange}
          open={exchangeOpen}
          onToggle={(e) => setExchangeOpen(e.currentTarget.open)}
        >
          <summary>
            商品代金の通貨・換算・注文番号
            <span>
              {values.currency && values.currency !== "JPY" ? values.currency : "円で入力"}
            </span>
          </summary>
          <ExchangeFields
            namePrefix=""
            actualName="actualOrderJpy"
            rateLabel={`商品代金の換算レート（1 ${values.currency || "JPY"} あたりの円）`}
            actualLabel="購入全体の円建て金額"
            value={{
              currency: values.currency,
              exchangeRate: values.exchangeRate,
              actualJpy: values.actualOrderJpy,
            }}
            onChange={(v) =>
              change({
                ...(v.currency !== undefined ? { currency: v.currency } : {}),
                ...(v.exchangeRate !== undefined ? { exchangeRate: v.exchangeRate } : {}),
                ...(v.actualJpy !== undefined ? { actualOrderJpy: v.actualJpy } : {}),
              })
            }
          />
          {missingProductRate && (
            <p className="commerce-caption">
              商品代金を円へ換算するためのレートを入力してください。
            </p>
          )}
          <label className="field">
            注文番号
            <input
              name="externalReference"
              value={values.externalReference || ""}
              onChange={(e) => change({ externalReference: e.target.value })}
            />
          </label>
        </details>
        <section className="commerce-section">
          <div className="commerce-section-heading">
            <h2>購入したもの</h2>
            <button
              className="commerce-text-button"
              type="button"
              onClick={() =>
                change({
                  lines: [
                    ...values.lines,
                    {
                      clientId: createClientUuid(),
                      variantId: "",
                      name: "",
                      trackingMode: "QUANTITY",
                      quantity: 1,
                      amount: "",
                      priceBasis: "UNIT",
                      weight: "",
                      volume: "",
                      condition: "",
                    },
                  ],
                })
              }
            >
              <Plus size={16} />
              明細を追加
            </button>
          </div>
          {values.lines.map((line, index) => (
            <div className="commerce-line-editor" key={line.clientId}>
              <div className="commerce-inline-fields">
                <label className="field">
                  商品名
                  <input
                    name={`lines.${index}.name`}
                    required
                    maxLength={120}
                    value={line.name}
                    onChange={(e) =>
                      lineChange(index, { name: e.target.value, variantId: "", supplyItemId: "" })
                    }
                  />
                </label>
                <label className="field">
                  数量
                  <input
                    type="number"
                    name={`lines.${index}.quantity`}
                    required
                    min="1"
                    max="1000000"
                    value={line.quantity || ""}
                    onChange={(e) =>
                      lineChange(index, {
                        quantity: e.target.value === "" ? 0 : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  {line.priceBasis === "UNIT"
                    ? `単価（${(values.currency || "JPY") === "JPY" ? "円" : values.currency}）`
                    : `明細金額（${values.currency || "JPY"}）`}
                  <input
                    required
                    inputMode="decimal"
                    name={`lines.${index}.amount`}
                    pattern={(values.currency || "JPY") === "JPY" ? "[0-9]+" : "[0-9]+(\\.[0-9]+)?"}
                    value={line.amount}
                    onChange={(e) =>
                      lineChange(index, { amount: e.target.value.replace(/[^\d.]/g, "") })
                    }
                  />
                </label>
              </div>
              {line.sourceName && line.sourceName !== line.name && (
                <p className="commerce-caption">取込名 {line.sourceName}</p>
              )}
              {(!line.purpose || line.purpose === "STOCK") && (
                <PurchaseProductPicker
                  context={values.context}
                  date={values.date}
                  mode={line.trackingMode}
                  selectedId={line.variantId}
                  onSelect={(choice) => lineChange(index, applyPurchaseChoice(line, choice))}
                />
              )}
              <div className="commerce-line-meta">
                <details>
                  <summary>
                    {line.purpose === "MATERIAL"
                      ? "資材・残数は管理しない"
                      : line.purpose === "EQUIPMENT"
                        ? "備品・残数は管理しない"
                        : line.variantId
                          ? "登録済みの商品"
                          : line.trackingMode === "UNIQUE"
                            ? "1点ごとに管理"
                            : "数量で管理"}
                  </summary>
                  <div className="commerce-fields">
                    {line.purpose && line.purpose !== "STOCK" && (
                      <label className="field">
                        登録済みのものから選ぶ
                        <select
                          name={`lines.${index}.supplyItemId`}
                          value={line.supplyItemId || ""}
                          onChange={(e) => {
                            const supply = supplies.find((s) => s.id === e.target.value);
                            lineChange(index, {
                              supplyItemId: supply?.id || "",
                              name: supply?.name || line.name,
                              supplyUnit: supply?.unit || "点",
                            });
                          }}
                        >
                          <option value="">新しい資材・備品として登録</option>
                          {supplies
                            .filter((s) => s.kind === line.purpose)
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name} · {s.unit}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                    <label className="field">
                      用途・管理方法
                      <select
                        value={
                          line.purpose && line.purpose !== "STOCK"
                            ? line.purpose
                            : line.trackingMode
                        }
                        onChange={(e) =>
                          lineChange(index, {
                            purpose: ["MATERIAL", "EQUIPMENT"].includes(e.target.value)
                              ? (e.target.value as "MATERIAL" | "EQUIPMENT")
                              : "STOCK",
                            variantId: "",
                            supplyItemId: "",
                            trackingMode: e.target.value === "UNIQUE" ? "UNIQUE" : "QUANTITY",
                            ...(e.target.value === "UNIQUE" ? { quantity: 1 } : {}),
                          })
                        }
                      >
                        <option value="QUANTITY">数量で管理</option>
                        <option value="UNIQUE">1点ごとに管理</option>
                        <option value="MATERIAL">資材・残数は管理しない</option>
                        <option value="EQUIPMENT">備品・残数は管理しない</option>
                      </select>
                    </label>
                    <label className="field">
                      金額の入力方法
                      <select
                        name={`lines.${index}.priceBasis`}
                        value={line.priceBasis}
                        onChange={(e) =>
                          lineChange(index, { priceBasis: e.target.value as "UNIT" | "LINE" })
                        }
                      >
                        <option value="UNIT">1個の単価</option>
                        <option value="LINE">この明細の合計</option>
                      </select>
                    </label>
                  </div>
                </details>
                <span className="commerce-number">
                  {calculation ? moneyLabel(calculation.amounts[index]) : "計算待ち"}
                </span>
                {values.lines.length > 1 && (
                  <button
                    type="button"
                    className="commerce-icon-button"
                    aria-label={`明細${index + 1}を削除`}
                    onClick={() => change({ lines: values.lines.filter((_, i) => i !== index) })}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>
        <CandidateImport
          kind="PURCHASE"
          title="送料・税額のファイルから追加"
          chargesOnly
          onApply={applyCharges}
        />
        <details className="commerce-disclosure" ref={costs}>
          <summary>
            送料・手数料・税額
            <span>{values.charges.length ? `${values.charges.length}件` : "必要な場合に追加"}</span>
          </summary>
          {values.charges.map((charge, index) => {
            const targets = values.lines.filter(
              (l) => !charge.lineIds.length || charge.lineIds.includes(l.clientId),
            );
            const result = calculation?.allocations[index];
            const update = (next: Partial<typeof charge>) =>
              change({
                charges: values.charges.map((c, i) => (i === index ? { ...c, ...next } : c)),
              });
            return (
              <ChargeGroup
                key={index}
                name={charge.name}
                onRemove={() => change({ charges: values.charges.filter((_, i) => i !== index) })}
              >
                <div className="commerce-fields">
                  <label className="field">
                    費用名
                    <input
                      name={`charges.${index}.name`}
                      value={charge.name}
                      required
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    金額（
                    {(charge.currency || values.currency || "JPY") === "JPY"
                      ? "円"
                      : charge.currency || values.currency}
                    ）
                    <input
                      name={`charges.${index}.amount`}
                      inputMode="numeric"
                      placeholder="未確認"
                      value={charge.amount}
                      onChange={(e) => update({ amount: e.target.value.replace(/[^\d.]/g, "") })}
                    />
                  </label>
                </div>
                <details className="commerce-disclosure">
                  <summary>
                    配分・原価への反映
                    <span>
                      {allocationLabels[charge.method]} ·{" "}
                      {charge.capitalized ? "商品原価" : "付随する経費"}
                    </span>
                  </summary>
                  <div className="commerce-fields">
                    <label className="field">
                      配分方法
                      <select
                        name={`charges.${index}.method`}
                        value={charge.method}
                        onChange={(e) => update({ method: e.target.value as AllocationMethod })}
                      >
                        {Object.entries(allocationLabels).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      原価への反映
                      <select
                        value={charge.capitalized ? "COST" : "EXPENSE"}
                        onChange={(e) => update({ capitalized: e.target.value === "COST" })}
                      >
                        <option value="COST">商品原価へ配分</option>
                        <option value="EXPENSE">付随する経費</option>
                      </select>
                    </label>
                  </div>
                </details>
                <details className="commerce-disclosure">
                  <summary>この費用の通貨・換算</summary>
                  <ExchangeFields
                    namePrefix={`charges.${index}.`}
                    value={{ ...charge, currency: charge.currency || values.currency || "JPY" }}
                    onChange={update}
                    inheritedRate={
                      (charge.currency || values.currency || "JPY") === (values.currency || "JPY")
                        ? values.exchangeRate
                        : undefined
                    }
                  />
                </details>
                <details className="commerce-disclosure">
                  <summary>配分先と内訳</summary>
                  {values.lines.map((line) => (
                    <label className="commerce-checkbox" key={line.clientId}>
                      <input
                        type="checkbox"
                        checked={!charge.lineIds.length || charge.lineIds.includes(line.clientId)}
                        onChange={(e) => {
                          const selected = charge.lineIds.length
                            ? charge.lineIds
                            : values.lines.map((l) => l.clientId);
                          const next = e.target.checked
                            ? [...new Set([...selected, line.clientId])]
                            : selected.filter((id) => id !== line.clientId);
                          if (next.length) update({ lineIds: next });
                        }}
                      />
                      {line.name || "商品名未入力"}
                    </label>
                  ))}
                </details>
                {["WEIGHT", "VOLUME", "MANUAL"].includes(charge.method) && (
                  <div className="commerce-fields">
                    {targets.map((line) => (
                      <label className="field" key={line.clientId}>
                        {line.name || "商品"} ·{" "}
                        {charge.method === "WEIGHT"
                          ? "1個の重量(g)"
                          : charge.method === "VOLUME"
                            ? "1個の容積(cm³)"
                            : "配分額（円）"}
                        <input
                          inputMode="decimal"
                          value={
                            charge.method === "WEIGHT"
                              ? line.weight
                              : charge.method === "VOLUME"
                                ? line.volume
                                : (charge.manual[line.clientId] ?? "")
                          }
                          onChange={(e) => {
                            const value = e.target.value.replace(/[^\d.]/g, "");
                            if (charge.method === "MANUAL")
                              update({ manual: { ...charge.manual, [line.clientId]: value } });
                            else
                              lineChange(
                                values.lines.indexOf(line),
                                charge.method === "WEIGHT" ? { weight: value } : { volume: value },
                              );
                          }}
                        />
                      </label>
                    ))}
                  </div>
                )}
                {result?.missing && <p className="commerce-caption">{result.missing}</p>}
                {result?.allocations && (
                  <p className="commerce-caption">
                    {result.allocations
                      .map(
                        (a) =>
                          `${values.lines.find((l) => l.clientId === a.lineId)?.name || "商品"} ${moneyLabel(a.amount)}`,
                      )
                      .join(" · ")}
                  </p>
                )}
              </ChargeGroup>
            );
          })}
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              change({
                charges: [
                  ...values.charges,
                  {
                    name: values.charges.length ? "手数料" : "送料",
                    amount: "",
                    method: (suppliers.find((s) => s.id === values.supplierId)?.allocation ||
                      "VALUE") as AllocationMethod,
                    capitalized: true,
                    lineIds: [],
                    manual: {},
                  },
                ],
              })
            }
          >
            <Plus size={16} />
            費用を追加
          </button>
          <div className="commerce-fields commerce-section">
            <label className="field">
              商品金額の税区分
              <select
                name="taxMode"
                value={values.taxMode}
                onChange={(e) => change({ taxMode: e.target.value as "INCLUDED" | "EXCLUDED" })}
              >
                <option value="INCLUDED">税込（金額全体を原価に算入）</option>
                <option value="EXCLUDED">税抜（税額を原価に加算）</option>
              </select>
            </label>
            <label className="field">
              {values.taxMode === "INCLUDED" ? "うち消費税（円・任意）" : "加算する消費税（円）"}
              <input
                name="taxAmount"
                inputMode="numeric"
                placeholder={values.taxMode === "INCLUDED" ? "未入力" : "未確認"}
                value={values.taxAmount}
                onChange={(e) => change({ taxAmount: e.target.value.replace(/[^\d]/g, "") })}
              />
            </label>
          </div>
        </details>
        <details className="commerce-disclosure">
          <summary>保管場所・メモ</summary>
          <div className="commerce-fields">
            <label className="field">
              保管場所
              <select
                name="locationId"
                required
                value={values.locationId}
                onChange={(e) => change({ locationId: e.target.value })}
              >
                <option value="">選択してください</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              メモ
              <textarea
                name="memo"
                value={values.memo}
                onChange={(e) => change({ memo: e.target.value })}
              />
            </label>
          </div>
        </details>
        <details className="commerce-disclosure">
          <summary>
            支払
            <span>
              {values.payment?.method && values.payment.method !== "NONE"
                ? values.payment.method === "PERSONAL"
                  ? "個人立替"
                  : "口座・カード"
                : "未払い"}
            </span>
          </summary>
          <label className="field">
            支払方法
            <select
              value={values.payment?.method ?? "NONE"}
              onChange={(e) =>
                change({
                  payment: {
                    date: values.payment?.date ?? values.date,
                    amount:
                      values.payment?.amount ||
                      (calculation?.final ? calculation.total.toString() : ""),
                    accountId: values.payment?.accountId ?? "",
                    accountRevision: values.payment?.accountRevision ?? 0,
                    method: e.target.value as "NONE" | "ACCOUNT" | "PERSONAL",
                  },
                })
              }
            >
              <option value="NONE">未払い・後で記録</option>
              <option value="ACCOUNT">口座・カード</option>
              <option value="PERSONAL">個人立替</option>
            </select>
          </label>
          {values.payment && values.payment.method !== "NONE" && (
            <div className="commerce-fields commerce-section">
              <label className="field">
                支払日
                <input
                  name="payment.date"
                  type="date"
                  required
                  value={values.payment.date}
                  onChange={(e) =>
                    change({ payment: { ...values.payment!, date: e.target.value } })
                  }
                />
              </label>
              <label className="field">
                支払額（円）
                <input
                  name="payment.amount"
                  required
                  inputMode="numeric"
                  value={values.payment.amount}
                  onChange={(e) =>
                    change({ payment: { ...values.payment!, amount: e.target.value } })
                  }
                />
              </label>
              {values.payment.method === "ACCOUNT" && (
                <PaymentAccount
                  name="payment.accountId"
                  accounts={accounts}
                  id={values.payment.accountId}
                  onChange={(accountId, accountRevision) =>
                    change({ payment: { ...values.payment!, accountId, accountRevision } })
                  }
                />
              )}
            </div>
          )}
        </details>
        <label className="commerce-checkbox">
          <input
            name="received"
            type="checkbox"
            checked={values.received}
            onChange={(e) =>
              change({
                received: e.target.checked,
                ...(!e.target.checked ? { createSkus: false } : {}),
              })
            }
          />
          受取済み
        </label>
        {values.received && values.lines.some((l) => !l.purpose || l.purpose === "STOCK") && (
          <label className="commerce-checkbox">
            <input
              type="checkbox"
              checked={values.createSkus ?? false}
              onChange={(e) => change({ createSkus: e.target.checked })}
            />
            単品の販売商品も登録する
          </label>
        )}
        <p className="commerce-caption">
          {values.received
            ? "保存すると、受取済みの数量を在庫に反映します。"
            : "未受取の購入として保存します。在庫への反映は受取の記録時です。"}
          {values.payment?.method && values.payment.method !== "NONE"
            ? " 支払も同時に記録します。"
            : " 支払は後から記録できます。"}
        </p>
        <ContextHelp title="数量・単価・販売商品の登録について">
          <p>
            通常は数量と1個の単価を入力します。明細の合計金額で入力する場合は「金額の入力方法」を変更してください。
          </p>
          <p>
            単品の販売商品を同時登録すると、受取後にそのまま販売を記録できます。セットで売る場合は商品画面で構成を登録します。
          </p>
        </ContextHelp>
        {!calculation &&
          calculationMessage &&
          (dirty || values.lines.some((l) => l.name || l.amount)) && (
            <div className="commerce-calculation-status" role="status">
              <p>{calculationMessage}</p>
              {(missingProductRate || incompleteIndex >= 0) && (
                <button
                  type="button"
                  className="commerce-text-button"
                  onClick={() => {
                    if (incompleteIndex >= 0) {
                      const line = values.lines[incompleteIndex]!;
                      const field =
                        !Number.isInteger(line.quantity) || line.quantity <= 0
                          ? "quantity"
                          : "amount";
                      form.current
                        ?.querySelector<HTMLInputElement>(
                          `[name="lines.${incompleteIndex}.${field}"]`,
                        )
                        ?.focus();
                    } else {
                      setExchangeOpen(true);
                      if (productExchange.current) productExchange.current.open = true;
                      productExchange.current
                        ?.querySelector<HTMLInputElement>("input[data-exchange-rate]")
                        ?.focus();
                    }
                  }}
                >
                  必要な入力欄へ移動
                </button>
              )}
            </div>
          )}
        <PurchaseCostSummary
          values={values}
          calculation={calculation}
          reason={calculationMessage}
          position={mutation.position || values.valuationPosition || ""}
          onPositionChange={mutation.setPosition}
        />
        <footer className="commerce-save">
          <div>
            <span className="commerce-secondary">購入合計</span>
            <strong className="commerce-total">
              {calculation ? moneyLabel(calculation.total) : "計算待ち"}
            </strong>
            {calculation && !calculation.final && (
              <small className="commerce-secondary">
                {calculation.allocations.some((a) => a.amountJpy === null)
                  ? "暫定・金額未入力の費用があります"
                  : "原価の配分待ち"}
              </small>
            )}
          </div>
          <button type="submit" className="button">
            {mutation.busy ? "保存中…" : values.received ? "保存して入庫" : "購入を保存"}
          </button>
        </footer>
      </fieldset>
      <MutationFeedback mutation={mutation} />
      {mutation.feedback.code === "CONFLICT" &&
        !mutation.frozen &&
        values.payment?.method === "ACCOUNT" && (
          <button
            type="button"
            className="commerce-text-button"
            disabled={paymentAccounts.busy}
            onClick={() =>
              void paymentAccounts.refresh((rows) =>
                change({
                  payment: {
                    ...values.payment!,
                    accountRevision:
                      rows.find((a) => a.id === values.payment?.accountId)?.revision ?? 0,
                  },
                }),
              )
            }
          >
            口座情報を再確認
          </button>
        )}
      {paymentAccounts.message && (
        <p role="status" className="commerce-caption">
          {paymentAccounts.message}
        </p>
      )}

      {mutation.feedback.error &&
        !mutation.frozen &&
        values.payment &&
        values.payment.method !== "NONE" && (
          <button
            type="button"
            className="commerce-text-button"
            onClick={() => change({ payment: { ...values.payment!, method: "NONE" } })}
          >
            未払いに切り替える
          </button>
        )}
      {mutation.draftState && (
        <p className="commerce-caption" role="status">
          {mutation.draftState}
        </p>
      )}
    </form>
  );
}
