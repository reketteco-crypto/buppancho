"use client";

import { HydratedForm } from "@/components/forms/hydrated-form";

import { useEffect, useMemo, useState } from "react";
import { updateContextAction } from "@/app/actions";

type Assignment = {
  year: number;
  reportingEntityName?: string;
  businessUnit: { id: string; name: string; color: string };
  defaultOperatorId: string | null;
};

export function ContextSelector(props: {
  operators: Array<{ id: string; displayName: string }>;
  assignments: Assignment[];
  activeOperatorId: string | null;
  activeBusinessUnitId: string | null;
  selectedYear: number | null;
}) {
  useEffect(() => {
    const current = `${props.activeOperatorId}:${props.activeBusinessUnitId}:${props.selectedYear}`;
    try {
      const key = "buppancho:catalog-input-context",
        previous = sessionStorage.getItem(key);
      if (previous && previous !== current) {
        for (const storageKey of Object.keys(sessionStorage))
          if (storageKey.startsWith("buppancho:catalog:")) sessionStorage.removeItem(storageKey);
        window.dispatchEvent(new Event("buppancho:catalog-selection"));
      }
      sessionStorage.setItem(key, current);
    } catch {}
  }, [props.activeOperatorId, props.activeBusinessUnitId, props.selectedYear]);
  const years = useMemo(
    () => [...new Set(props.assignments.map((item) => item.year))].sort((a, b) => b - a),
    [props.assignments],
  );
  const initialYear =
    props.selectedYear && years.includes(props.selectedYear)
      ? props.selectedYear
      : (years[0] ?? 2026);
  const [year, setYear] = useState(initialYear);
  const units = props.assignments.filter((item) => item.year === year);
  const initialAssignment =
    units.find((item) => item.businessUnit.id === props.activeBusinessUnitId) ?? units[0];
  const [businessUnitId, setBusinessUnitId] = useState(initialAssignment?.businessUnit.id ?? "");
  const [operatorId, setOperatorId] = useState(
    props.activeOperatorId ?? initialAssignment?.defaultOperatorId ?? props.operators[0]?.id ?? "",
  );

  const selectYear = (nextYear: number) => {
    setYear(nextYear);
    const first = props.assignments.find((item) => item.year === nextYear);
    setBusinessUnitId(first?.businessUnit.id ?? "");
  };
  const selectUnit = (unitId: string) => {
    setBusinessUnitId(unitId);
  };

  return (
    <details className="context-selector">
      <summary>
        <span className="context-destination">
          <span className="context-unit">
            {props.assignments.find((v) => v.businessUnit.id === props.activeBusinessUnitId)
              ?.businessUnit.name ?? "部門未選択"}
          </span>
          <span className="context-year"> · {props.selectedYear}年</span>
        </span>
        <span className="context-operator">
          {" "}
          ·{" "}
          {props.operators.find((v) => v.id === props.activeOperatorId)?.displayName ??
            "入力者未選択"}
        </span>
        <span className="muted"> 変更</span>
      </summary>
      <p className="muted">
        途中入力は元の入力者・部門・年度に保存されます。部門を変えても入力者は変更しません。
      </p>
      <p className="muted">
        変更先の帰属：
        {units.find((v) => v.businessUnit.id === businessUnitId)?.reportingEntityName ??
          "部門と年度を選択してください"}
      </p>
      <HydratedForm action={updateContextAction} className="context-form">
        <label className="field">
          <span>入力者</span>
          <select
            name="operatorId"
            value={operatorId}
            onChange={(event) => setOperatorId(event.target.value)}
          >
            {props.operators.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>販売部門</span>
          <select
            name="businessUnitId"
            value={businessUnitId}
            onChange={(event) => selectUnit(event.target.value)}
          >
            {units.map((item) => (
              <option key={item.businessUnit.id} value={item.businessUnit.id}>
                {item.businessUnit.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>対象年度</span>
          <select
            name="year"
            value={year}
            onChange={(event) => selectYear(Number(event.target.value))}
          >
            {years.map((item) => (
              <option key={item} value={item}>
                {item}年
              </option>
            ))}
          </select>
        </label>
        <button className="button secondary" type="submit">
          切り替え
        </button>
      </HydratedForm>
    </details>
  );
}
