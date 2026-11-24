"use client";
import { useState } from "react";
import type { z } from "zod";
import type { receiveSchema } from "@/lib/commerce/input";
import { MutationFeedback, useCommerceMutation } from "./mutation";

export function ReceiptEditor({
  initial,
  lines,
  locations,
}: {
  initial: z.infer<typeof receiveSchema>;
  lines: {
    id: string;
    name: string;
    remaining: number;
    deliveries?: { id: string; name: string; remaining: number }[];
  }[];
  locations: { id: string; name: string }[];
}) {
  const [values, setValues] = useState(initial);
  const mutation = useCommerceMutation("RECEIVE", {
    ...values,
    lines: values.lines.filter((l) => l.quantity > 0),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void mutation.submit();
      }}
    >
      <fieldset className="commerce-fieldset" disabled={mutation.busy || mutation.frozen}>
        <div className="commerce-fields">
          <label className="field">
            受取日
            <input
              name="date"
              type="date"
              required
              value={values.date}
              onChange={(e) => setValues({ ...values, date: e.target.value })}
            />
          </label>
          <label className="field">
            保管場所
            <select
              name="locationId"
              value={values.locationId}
              onChange={(e) => setValues({ ...values, locationId: e.target.value })}
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="commerce-section">
          {lines.map((line) => (
            <div className="commerce-line-editor" key={line.id}>
              <div className="commerce-row">
                <div>
                  <strong>{line.name}</strong>
                  <span className="commerce-secondary">未受取 {line.remaining} 点</span>
                </div>
                <label className="field">
                  受取数量
                  <input
                    aria-label={`${line.name}の受取数量`}
                    type="number"
                    min="0"
                    max={line.remaining}
                    value={values.lines.find((l) => l.lineId === line.id)?.quantity ?? 0}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        lines: values.lines.map((l) =>
                          l.lineId === line.id ? { ...l, quantity: Number(e.target.value) } : l,
                        ),
                      })
                    }
                  />
                </label>
              </div>
              {!!line.deliveries?.length && (
                <label className="field">
                  受け取った配送
                  <select
                    value={values.lines.find((r) => r.lineId === line.id)?.deliveryLineId || ""}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        lines: values.lines.map((r) =>
                          r.lineId === line.id
                            ? {
                                ...r,
                                deliveryLineId: e.target.value || undefined,
                                quantity: Math.min(
                                  r.quantity,
                                  line.deliveries?.find((d) => d.id === e.target.value)
                                    ?.remaining ?? line.remaining,
                                ),
                              }
                            : r,
                        ),
                      })
                    }
                  >
                    <option value="">配送に紐づけない</option>
                    {line.deliveries.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · 未受取 {d.remaining}点
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ))}
        </div>
        <div className="commerce-action-row">
          <button type="submit" className="button">
            受取を記録
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={mutation} />
    </form>
  );
}
