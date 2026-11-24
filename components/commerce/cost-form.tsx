"use client";
import { useState } from "react";
import type { z } from "zod";
import type { purchaseCostSchema } from "@/lib/commerce/input";
import { CostFields, blankCharge } from "./cost-fields";
import { MutationFeedback, useCommerceMutation } from "./mutation";
import { CandidateImport } from "./import-candidate";
import { ChargeGroup } from "./charge-group";
export function PurchaseCostEditor({
  initial,
  lines,
  refund = false,
}: {
  initial: z.infer<typeof purchaseCostSchema>;
  lines: { id: string; name: string }[];
  refund?: boolean;
}) {
  const [values, setValues] = useState(initial);
  const [hasChargeInput, setHasChargeInput] = useState(false);
  const mutation = useCommerceMutation(refund ? "PURCHASE_REFUND" : "PURCHASE_COST", values);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void mutation.submit();
      }}
    >
      <fieldset
        className="commerce-fieldset"
        disabled={!mutation.ready || mutation.busy || mutation.frozen}
      >
        {!values.supersedesId && (
          <CandidateImport
            kind="COST"
            chargesOnly
            title="請求書・費用明細から入力"
            onApply={(candidate) => {
              const charges = candidate.charges.map((ch) => ({
                ...blankCharge(),
                name: ch.name,
                amount: ch.amount ?? "",
                currency: ch.currency,
              }));
              if (charges[0]) {
                setValues(
                  !hasChargeInput && !values.charge.amount
                    ? { ...values, charge: charges[0], additionalCharges: charges.slice(1) }
                    : { ...values, additionalCharges: [...values.additionalCharges, ...charges] },
                );
                setHasChargeInput(true);
              }
            }}
          />
        )}
        <label className="field">
          記録日
          <input
            name="date"
            type="date"
            required
            value={values.date}
            onChange={(e) => setValues({ ...values, date: e.target.value })}
          />
        </label>
        <ChargeGroup name={values.charge.name}>
          <CostFields
            value={values.charge}
            onChange={(v) => {
              setHasChargeInput(true);
              setValues({ ...values, charge: { ...values.charge, ...v } });
            }}
            lines={lines}
            bases={values.bases}
            onBasisChange={(bases) => setValues({ ...values, bases })}
          />
        </ChargeGroup>
        {values.additionalCharges.map((ch, i) => (
          <ChargeGroup
            name={ch.name}
            key={i}
            onRemove={() =>
              setValues({
                ...values,
                additionalCharges: values.additionalCharges.filter((_, j) => j !== i),
              })
            }
          >
            <CostFields
              value={ch}
              onChange={(v) =>
                setValues({
                  ...values,
                  additionalCharges: values.additionalCharges.map((r, j) =>
                    j === i ? { ...r, ...v } : r,
                  ),
                })
              }
              lines={lines}
              bases={values.bases}
              onBasisChange={(bases) => setValues({ ...values, bases })}
            />
          </ChargeGroup>
        ))}
        <label className="field">
          理由
          <input
            name="reason"
            required
            value={values.reason}
            placeholder={refund ? "不良品の値引きなど" : "追加請求・金額確認など"}
            onChange={(e) => setValues({ ...values, reason: e.target.value })}
          />
        </label>
        <div className="commerce-action-row">
          <button type="submit" className="button">
            {refund ? "返金を記録" : "費用を保存"}
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={mutation} />
    </form>
  );
}
