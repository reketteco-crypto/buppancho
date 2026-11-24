"use client";
import Link from "next/link";
import { moneyReturnHref } from "@/lib/commerce/money-navigation";
import { PaymentAccount, usePaymentAccounts } from "./payment-fields";
import { useState } from "react";
import type { z } from "zod";
import type { otherRecordSchema } from "@/lib/commerce/input";
import type { AccountChoice } from "./money-form";
import { MutationFeedback, useCommerceMutation } from "./mutation";
export type CategoryChoice = { id: string; name: string; kind: string; revision: number };
export function OtherRecordEditor({
  initial,
  accounts: initialAccounts,
  categories,
  returnTo,
}: {
  initial: z.infer<typeof otherRecordSchema>;
  accounts: AccountChoice[];
  categories: CategoryChoice[];
  returnTo?: string;
}) {
  const paymentAccounts = usePaymentAccounts(initialAccounts, initial.context),
    accounts = paymentAccounts.accounts;
  const [v, setV] = useState(initial),
    m = useCommerceMutation("OTHER_RECORD", v, undefined, moneyReturnHref(returnTo)),
    cancel = !!v.reversesId;
  return (
    <form
      className="commerce-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit();
      }}
    >
      <fieldset className="commerce-fieldset" disabled={m.busy || m.frozen}>
        <div className="commerce-fields">
          <label className="field">
            {cancel ? "取消日" : "日付"}
            <input
              name="date"
              required
              type="date"
              value={v.date}
              onChange={(e) => setV({ ...v, date: e.target.value })}
            />
          </label>
          {!cancel && (
            <>
              <label className="field">
                項目
                <input
                  required
                  name="categoryName"
                  value={v.categoryName}
                  list="other-categories"
                  onChange={(e) => {
                    const c = categories.find(
                      (c) => c.kind === v.kind && c.name === e.target.value,
                    );
                    setV({
                      ...v,
                      categoryName: e.target.value,
                      categoryId: c?.id || "",
                      categoryRevision: c?.revision,
                    });
                  }}
                />
                <datalist id="other-categories">
                  {categories
                    .filter((c) => c.kind === v.kind)
                    .map((c) => (
                      <option key={c.id} value={c.name} />
                    ))}
                </datalist>
              </label>
              <label className="field">
                金額（円）
                <input
                  name="amount"
                  required
                  inputMode="numeric"
                  value={v.amount}
                  onChange={(e) => setV({ ...v, amount: e.target.value })}
                />
              </label>
            </>
          )}
        </div>
        {cancel ? (
          <label className="field">
            取消理由
            <input
              name="memo"
              required
              value={v.memo}
              onChange={(e) => setV({ ...v, memo: e.target.value })}
            />
          </label>
        ) : (
          <>
            <details className="commerce-disclosure">
              <summary>取引先・メモ</summary>
              <label className="field">
                取引先
                <input
                  name="counterparty"
                  value={v.counterparty}
                  onChange={(e) => setV({ ...v, counterparty: e.target.value })}
                />
              </label>
              <label className="field">
                メモ
                <textarea
                  name="memo"
                  value={v.memo}
                  onChange={(e) => setV({ ...v, memo: e.target.value })}
                />
              </label>
            </details>
            <label className="commerce-checkbox">
              <input
                type="checkbox"
                checked={v.settled}
                disabled={v.kind === "INCOME" && !accounts.length}
                onChange={(e) => setV({ ...v, settled: e.target.checked })}
              />
              {v.kind === "EXPENSE" ? "支払済み" : "入金済み"}
            </label>
            {!accounts.length && (
              <p className="commerce-caption">
                入出金の口座がまだありません。
                <Link href="/settings/accounts" target="_blank" rel="noopener noreferrer">
                  口座を別画面で設定
                </Link>
                し、
                <button
                  type="button"
                  className="commerce-text-button"
                  disabled={paymentAccounts.busy}
                  onClick={() => void paymentAccounts.refresh(() => {})}
                >
                  口座を再取得
                </button>
                してください。
              </p>
            )}
            {v.settled && v.kind === "EXPENSE" && (
              <label className="field">
                支払方法
                <select
                  value={v.paymentMethod ?? "ACCOUNT"}
                  onChange={(e) =>
                    setV({ ...v, paymentMethod: e.target.value as "ACCOUNT" | "PERSONAL" })
                  }
                >
                  <option value="ACCOUNT">口座・カード</option>
                  <option value="PERSONAL">個人立替</option>
                </select>
              </label>
            )}
            {v.settled && v.paymentMethod !== "PERSONAL" && (
              <PaymentAccount
                accounts={accounts}
                id={v.accountId}
                onChange={(accountId, accountRevision) =>
                  setV((current) => ({ ...current, accountId, accountRevision }))
                }
              />
            )}
          </>
        )}
        <div className="commerce-save">
          <span>{v.kind === "EXPENSE" ? "費用" : "収入"}</span>
          <button className="button" type="submit">
            {cancel ? "収支を取り消す" : "保存"}
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={m} />
      {m.feedback.code === "CONFLICT" && !m.frozen && (
        <button
          type="button"
          className="commerce-text-button"
          disabled={paymentAccounts.busy}
          onClick={() =>
            void paymentAccounts.refresh((rows) =>
              setV((current) => ({
                ...current,
                accountRevision: rows.find((a) => a.id === current.accountId)?.revision ?? 0,
              })),
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
    </form>
  );
}
