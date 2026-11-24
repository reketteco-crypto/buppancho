"use client";
import { allocationLabels, type AllocationMethod } from "@/lib/commerce/allocation";
import type { BuyInput } from "@/lib/commerce/input";
import { useId } from "react";

export type ChargeValue = BuyInput["charges"][number];
export const blankCharge = (): ChargeValue => ({
  name: "送料",
  amount: "",
  currency: "JPY",
  method: "VALUE",
  capitalized: true,
  lineIds: [],
  manual: {},
});
export function ExchangeFields({
  value,
  onChange,
  rateLabel = "1通貨あたりの円",
  actualLabel = "円建て金額",
  inheritedRate,
  namePrefix,
  actualName = "actualJpy",
}: {
  value: { currency?: string; exchangeRate?: string; actualJpy?: string };
  onChange: (v: Partial<ChargeValue>) => void;
  rateLabel?: string;
  actualLabel?: string;
  inheritedRate?: string;
  namePrefix?: string;
  actualName?: string;
}) {
  const currenciesId = useId();
  return (
    <div className="commerce-fields">
      <label className="field">
        通貨
        <input
          name={namePrefix === undefined ? undefined : `${namePrefix}currency`}
          maxLength={3}
          value={value.currency || "JPY"}
          onChange={(e) =>
            onChange({ currency: e.target.value.toUpperCase(), exchangeRate: "", actualJpy: "" })
          }
          list={currenciesId}
        />
        <datalist id={currenciesId}>
          {["JPY", "CNY", "USD", "EUR", "KRW"].map((v) => (
            <option value={v} key={v} />
          ))}
        </datalist>
      </label>
      {(value.currency || "JPY") !== "JPY" && (
        <>
          <label className="field">
            {rateLabel}
            <input
              inputMode="decimal"
              name={namePrefix === undefined ? undefined : `${namePrefix}exchangeRate`}
              data-exchange-rate
              placeholder={inheritedRate ? `商品代金と同じ（${inheritedRate}）` : "換算レート"}
              value={value.exchangeRate || ""}
              onChange={(e) => onChange({ exchangeRate: e.target.value })}
            />
            {!value.exchangeRate && inheritedRate && !value.actualJpy && (
              <small className="commerce-caption">
                商品代金の換算レート {inheritedRate} を使用
              </small>
            )}
          </label>
          <label className="field">
            {actualLabel}
            <input
              inputMode="numeric"
              name={namePrefix === undefined ? undefined : `${namePrefix}${actualName}`}
              placeholder="実額が分かる場合"
              value={value.actualJpy || ""}
              onChange={(e) => onChange({ actualJpy: e.target.value })}
            />
          </label>
        </>
      )}
    </div>
  );
}
export function CostFields({
  value,
  onChange,
  lines,
  bases,
  onBasisChange,
}: {
  value: ChargeValue;
  onChange: (v: Partial<ChargeValue>) => void;
  lines: { id: string; name: string }[];
  bases: Record<string, { weight: string; volume: string; manual: string }>;
  onBasisChange: (v: typeof bases) => void;
}) {
  const selected = lines.filter((l) => !value.lineIds.length || value.lineIds.includes(l.id));
  return (
    <>
      <div className="commerce-fields">
        <label className="field">
          費用名
          <input required value={value.name} onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className="field">
          金額（{value.currency || "JPY"}）
          <input
            inputMode="decimal"
            placeholder="未確認"
            value={value.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
          />
        </label>
      </div>
      <details className="commerce-disclosure">
        <summary>通貨・換算</summary>
        <ExchangeFields value={value} onChange={onChange} />
      </details>
      <div className="commerce-fields">
        <label className="field">
          配分方法
          <select
            value={value.method}
            onChange={(e) => onChange({ method: e.target.value as AllocationMethod })}
          >
            {Object.entries(allocationLabels).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          原価への反映
          <select
            value={value.capitalized ? "COST" : "EXPENSE"}
            onChange={(e) => onChange({ capitalized: e.target.value === "COST" })}
          >
            <option value="COST">商品原価へ配分</option>
            <option value="EXPENSE">付随する経費</option>
          </select>
        </label>
      </div>
      <details className="commerce-disclosure">
        <summary>配分先を選ぶ</summary>
        {lines.map((l) => (
          <label className="commerce-checkbox" key={l.id}>
            <input
              type="checkbox"
              checked={!value.lineIds.length || value.lineIds.includes(l.id)}
              onChange={(e) => {
                const ids = value.lineIds.length ? value.lineIds : lines.map((r) => r.id);
                const next = e.target.checked
                  ? [...new Set([...ids, l.id])]
                  : ids.filter((id) => id !== l.id);
                if (next.length) onChange({ lineIds: next });
              }}
            />
            {l.name}
          </label>
        ))}
      </details>
      {["WEIGHT", "VOLUME", "MANUAL"].includes(value.method) && (
        <div className="commerce-fields">
          {selected.map((l) => {
            const key =
              value.method === "WEIGHT"
                ? "weight"
                : value.method === "VOLUME"
                  ? "volume"
                  : "manual";
            return (
              <label className="field" key={l.id}>
                {l.name} ·{" "}
                {key === "weight"
                  ? "1点の重量(g)"
                  : key === "volume"
                    ? "1点の容積(cm³)"
                    : "配分額（円）"}
                <input
                  inputMode="decimal"
                  value={bases[l.id]?.[key] || ""}
                  onChange={(e) => {
                    onBasisChange({
                      ...bases,
                      [l.id]: {
                        weight: "",
                        volume: "",
                        manual: "",
                        ...bases[l.id],
                        [key]: e.target.value,
                      },
                    });
                    if (key === "manual")
                      onChange({ manual: { ...value.manual, [l.id]: e.target.value } });
                  }}
                />
              </label>
            );
          })}
        </div>
      )}
    </>
  );
}
