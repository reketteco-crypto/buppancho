"use client";
import { createClientUuid } from "@/lib/client-uuid";
import { useState } from "react";
export function MeasurementFields({
  initial,
  onChange,
}: {
  initial: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState(() =>
    Object.entries(initial).map(([name, value]) => ({ id: createClientUuid(), name, value })),
  );
  function change(next: typeof rows) {
    setRows(next);
    onChange(
      Object.fromEntries(
        next
          .filter((r) => r.name.trim() && r.value.trim())
          .map((r) => [r.name.trim(), r.value.trim()]),
      ),
    );
  }
  return (
    <fieldset className="form-stack">
      <legend>採寸・補足情報（任意）</legend>
      {rows.map((r, i) => (
        <div className="form-grid" key={r.id}>
          <label className="field">
            <span>項目名</span>
            <input
              value={r.name}
              placeholder="肩幅"
              onChange={(e) =>
                change(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
            />
          </label>
          <label className="field">
            <span>値</span>
            <input
              value={r.value}
              placeholder="40cm"
              onChange={(e) =>
                change(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
              }
            />
          </label>
          <button
            type="button"
            className="button secondary"
            onClick={() => change(rows.filter((_, j) => j !== i))}
          >
            項目を取り除く
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button secondary"
        onClick={() => setRows([...rows, { id: createClientUuid(), name: "", value: "" }])}
      >
        採寸の項目を追加
      </button>
    </fieldset>
  );
}
