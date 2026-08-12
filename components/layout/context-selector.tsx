"use client";

import { useMemo, useState } from "react";
import { updateContextAction } from "@/app/actions";

type Assignment = {
  year: number;
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
    setOperatorId(first?.defaultOperatorId ?? props.operators[0]?.id ?? "");
  };
  const selectUnit = (unitId: string) => {
    setBusinessUnitId(unitId);
    const selected = props.assignments.find(
      (item) => item.year === year && item.businessUnit.id === unitId,
    );
    if (selected?.defaultOperatorId) setOperatorId(selected.defaultOperatorId);
  };

  return (
    <form action={updateContextAction} className="context-form">
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
    </form>
  );
}
