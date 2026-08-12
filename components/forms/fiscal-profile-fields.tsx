"use client";

import { useState } from "react";

type Values = {
  filingMethod: string;
  consumptionTaxStatus: string;
  blueDeductionTarget: string;
  inventoryValuationMethod: string;
  inventoryValuationMethodNote: string | null;
};

export function FiscalProfileFields({ values }: { values?: Values }) {
  const [filingMethod, setFilingMethod] = useState(values?.filingMethod ?? "BLUE");
  const [deduction, setDeduction] = useState(values?.blueDeductionTarget ?? "");
  const [valuation, setValuation] = useState(values?.inventoryValuationMethod ?? "");
  return (
    <div className="setup-grid">
      <label className="field">
        <span>申告方式</span>
        <select
          name="filingMethod"
          value={filingMethod}
          onChange={(event) => {
            setFilingMethod(event.target.value);
            if (event.target.value === "WHITE") setDeduction("NONE");
          }}
        >
          <option value="BLUE">青色</option>
          <option value="WHITE">白色</option>
        </select>
      </label>
      <label className="field">
        <span>消費税区分</span>
        <select
          name="consumptionTaxStatus"
          defaultValue={values?.consumptionTaxStatus ?? ""}
          required
        >
          <option value="" disabled>
            確認して選択
          </option>
          <option value="EXEMPT">免税事業者</option>
          <option value="TAXABLE">課税事業者</option>
          <option value="INVOICE_REGISTERED">インボイス登録事業者</option>
        </select>
      </label>
      <label className="field">
        <span>青色申告特別控除の目標</span>
        <select
          name="blueDeductionTarget"
          value={deduction}
          disabled={filingMethod === "WHITE"}
          required
          onChange={(event) => setDeduction(event.target.value)}
        >
          <option value="" disabled>
            確認して選択
          </option>
          <option value="NONE">なし</option>
          <option value="DEDUCTION_100K">10万円</option>
          <option value="DEDUCTION_550K">55万円</option>
          <option value="DEDUCTION_650K">65万円</option>
        </select>
        {filingMethod === "WHITE" ? (
          <input type="hidden" name="blueDeductionTarget" value="NONE" />
        ) : null}
      </label>
      <label className="field">
        <span>棚卸資産の評価方法</span>
        <select
          name="inventoryValuationMethod"
          value={valuation}
          onChange={(event) => setValuation(event.target.value)}
          required
        >
          <option value="" disabled>
            確認して選択
          </option>
          <option value="SPECIFIC">個別法</option>
          <option value="LAST_PURCHASE_COST">最終仕入原価法</option>
          <option value="GROSS_AVERAGE">総平均法</option>
          <option value="OTHER">その他</option>
        </select>
      </label>
      {valuation === "OTHER" ? (
        <label className="field">
          <span>「その他」の場合の方法</span>
          <input
            name="inventoryValuationMethodNote"
            defaultValue={values?.inventoryValuationMethodNote ?? ""}
            maxLength={200}
            required
          />
        </label>
      ) : null}
    </div>
  );
}
