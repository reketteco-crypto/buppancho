"use client";
import { moneyReturnHref } from "@/lib/commerce/money-navigation";
import { SearchSelect } from "./ui";
import { usePaymentAccounts } from "./payment-fields";
import { useOwnerPreview } from "./owner-preview";
import { accountBalanceView } from "@/lib/commerce/account-label";
import { useEffect, useState } from "react";
import type { z } from "zod";
import type { accountSchema, moneySchema } from "@/lib/commerce/input";
import { MutationFeedback, useCommerceMutation } from "./mutation";
export type AccountChoice = {
  id: string;
  name: string;
  revision: number;
  balance: string;
  accountKind?: string;
};
export function AccountEditor({
  initial,
  returnTo,
}: {
  initial: z.infer<typeof accountSchema>;
  returnTo?: string;
}) {
  const [v, setV] = useState(initial),
    m = useCommerceMutation("ACCOUNT_SAVE", v, undefined, moneyReturnHref(returnTo));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit();
      }}
    >
      <fieldset className="commerce-fieldset" disabled={!m.ready || m.busy || m.frozen}>
        <div className="commerce-fields">
          <label className="field">
            口座名
            <input
              name="name"
              required
              placeholder="事業用口座・取引先の預け金など"
              value={v.name}
              onChange={(e) => setV((current) => ({ ...current, name: e.target.value }))}
            />
          </label>
          <label className="field">
            口座の種類
            <select
              value={v.accountKind ?? "STANDARD"}
              onChange={(e) =>
                setV((current) => ({
                  ...current,
                  accountKind: e.target.value as "STANDARD" | "CREDIT_CARD",
                }))
              }
            >
              <option value="STANDARD">通常口座</option>
              <option value="CREDIT_CARD">クレジットカード</option>
            </select>
          </label>
          {v.id && v.accountKind !== initial.accountKind && (
            <p className="commerce-caption">種別変更では開始残高・入出金を変更しません。</p>
          )}
          {!v.id && (
            <>
              <label className="field">
                開始日
                <input
                  name="date"
                  type="date"
                  required
                  value={v.date}
                  onChange={(e) => setV((current) => ({ ...current, date: e.target.value }))}
                />
              </label>
              <label className="field">
                {v.accountKind === "CREDIT_CARD" ? "開始時の未払額（円）" : "開始残高（円）"}
                <input
                  name="balance"
                  required
                  inputMode="numeric"
                  value={v.balance}
                  onChange={(e) => setV((current) => ({ ...current, balance: e.target.value }))}
                />
              </label>
            </>
          )}
        </div>
        {!!v.id && (
          <label className="commerce-checkbox">
            <input
              type="checkbox"
              checked={v.active}
              onChange={(e) => setV((current) => ({ ...current, active: e.target.checked }))}
            />
            有効
          </label>
        )}
        <div className="commerce-action-row">
          <button className="button" type="submit">
            口座を保存
          </button>
        </div>
      </fieldset>
      <MutationFeedback mutation={m} />
    </form>
  );
}
export function MoneyEditor({
  initial,
  accounts: initialAccounts,
  movement = false,
  returnTo,
  onPendingChange,
}: {
  initial: z.infer<typeof moneySchema>;
  accounts: AccountChoice[];
  movement?: boolean;
  returnTo?: string;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [v, setV] = useState(initial);
  const paymentAccounts = usePaymentAccounts(initialAccounts, initial.context),
    accounts = paymentAccounts.accounts;
  const owner = v.kind === "OWNER_REIMBURSEMENT" || v.kind === "OWNER_REPAYMENT",
    personal = v.paymentMethod === "PERSONAL";
  const ownerPreview = useOwnerPreview(v, owner && /^\d+$/.test(v.amount) && BigInt(v.amount) > 0n);
  const m = useCommerceMutation(
    "MONEY_RECORD",
    {
      ...v,
      ...(owner ? { ownerFingerprint: ownerPreview.plan?.fingerprint } : {}),
    },
    undefined,
    moneyReturnHref(returnTo),
  );
  useEffect(() => {
    onPendingChange?.(m.busy || m.frozen);
  }, [m.busy, m.frozen, onPendingChange]);
  const transfer = v.kind === "TRANSFER",
    reversal = v.kind === "REVERSAL",
    outgoing = v.kind === "OWNER_DRAWING" || v.kind === "OWNER_REIMBURSEMENT";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void m.submit();
      }}
    >
      <fieldset className="commerce-fieldset" disabled={!m.ready || m.busy || m.frozen}>
        {movement && (
          <label className="field commerce-section">
            資金移動の内容
            <select
              name="kind"
              value={v.kind}
              onChange={(e) =>
                setV((current) => ({
                  ...current,
                  kind: e.target.value as typeof v.kind,
                  toAccountId: "",
                  fee: "0",
                }))
              }
            >
              <option value="TRANSFER">口座間振替・カード引落</option>
              <option value="OWNER_CONTRIBUTION">私用から事業へ入金</option>
              <option value="OWNER_DRAWING">事業から私用へ送金</option>
              <option value="OWNER_REIMBURSEMENT">本人立替の精算</option>
              <option value="OWNER_REPAYMENT">本人から立替差額を返金</option>
            </select>
          </label>
        )}
        {!movement && !reversal && (
          <label className="field">
            支払・受取方法
            <select
              value={v.paymentMethod ?? "ACCOUNT"}
              onChange={(e) =>
                setV((current) => ({
                  ...current,
                  paymentMethod: e.target.value as "ACCOUNT" | "PERSONAL",
                }))
              }
            >
              <option value="ACCOUNT">口座・カード</option>
              <option value="PERSONAL">本人の私用資金（立替・返金受取）</option>
            </select>
          </label>
        )}
        {movement && (
          <p className="commerce-caption">
            {transfer
              ? "送金額を振替先へ反映し、振替元から送金額と手数料を差し引きます。"
              : owner
                ? "口座への入出金と、本人立替への充当をまとめて記録します。下の充当内訳を確認してください。"
                : v.kind === "OWNER_CONTRIBUTION"
                  ? "本人の私用資金から事業口座への入金を記録します。"
                  : "事業口座から本人の私用資金への送金を記録します。"}
          </p>
        )}
        <div className="commerce-fields">
          <label className="field">
            {reversal ? "取消日" : movement ? "日付" : "決済日"}
            <input
              name="date"
              type="date"
              required
              value={v.date}
              onChange={(e) => setV((current) => ({ ...current, date: e.target.value }))}
            />
          </label>
          {!reversal && (
            <>
              {!personal && (
                <>
                  {" "}
                  <SearchSelect
                    label={transfer ? "振替元" : "口座"}
                    name="accountId"
                    required
                    value={v.accountId}
                    limit={accounts.length || 50}
                    options={accounts
                      .filter((a) => !owner || a.accountKind !== "CREDIT_CARD")
                      .map((a) => {
                        const balance = accountBalanceView(
                          a.accountKind ?? "STANDARD",
                          BigInt(a.balance),
                        );
                        return {
                          id: a.id,
                          label: `${a.name} · ${a.accountKind === "CREDIT_CARD" ? `${balance.label} ` : ""}¥${balance.amount.toLocaleString("ja-JP")}`,
                        };
                      })}
                    onChange={(accountId) =>
                      setV((current) => ({
                        ...current,
                        accountId,
                        accountRevision: accounts.find((a) => a.id === accountId)?.revision || 0,
                      }))
                    }
                  />
                </>
              )}
              {transfer && (
                <SearchSelect
                  label="振替先"
                  name="toAccountId"
                  required
                  value={v.toAccountId}
                  limit={accounts.length || 50}
                  options={accounts
                    .filter((a) => a.id !== v.accountId)
                    .map((a) => ({ id: a.id, label: a.name }))}
                  onChange={(toAccountId) =>
                    setV((current) => ({
                      ...current,
                      toAccountId,
                      toAccountRevision: accounts.find((a) => a.id === toAccountId)?.revision || 0,
                    }))
                  }
                />
              )}
              <label className="field">
                金額（円）
                <input
                  name="amount"
                  required
                  inputMode="numeric"
                  value={v.amount}
                  onChange={(e) => setV((current) => ({ ...current, amount: e.target.value }))}
                />
              </label>
              {(transfer || outgoing) && (
                <label className="field">
                  振込手数料（円）
                  <input
                    name="fee"
                    inputMode="numeric"
                    placeholder="0"
                    value={v.fee}
                    onChange={(e) => setV((current) => ({ ...current, fee: e.target.value }))}
                  />
                </label>
              )}
            </>
          )}
        </div>
        <label className="field">
          {reversal ? "取消理由" : "メモ（任意）"}
          <input
            name="memo"
            required={reversal}
            value={v.memo}
            onChange={(e) => setV((current) => ({ ...current, memo: e.target.value }))}
          />
        </label>
        {owner && (
          <section className="commerce-section">
            <h2>充当内訳</h2>
            {ownerPreview.plan?.allocations.map((a) => (
              <div className="commerce-summary-line" key={a.sourceTransactionId}>
                <span>
                  {a.date} · {a.name}
                </span>
                <strong>¥{BigInt(a.amountJpy).toLocaleString("ja-JP")}</strong>
              </div>
            ))}
            {!ownerPreview.plan && !ownerPreview.error && (
              <p className="commerce-caption">金額を入力すると内訳を確認できます。</p>
            )}
            {ownerPreview.error && (
              <p role="alert" className="field-error">
                {ownerPreview.error}
              </p>
            )}
            <button type="button" className="commerce-text-button" onClick={ownerPreview.refresh}>
              充当内訳を再確認
            </button>
          </section>
        )}
        <div className="commerce-action-row">
          <button className="button" type="submit" disabled={owner && !ownerPreview.plan}>
            {reversal
              ? "反対の入出金で取り消す"
              : transfer
                ? "振替を記録"
                : movement
                  ? "資金移動を記録"
                  : "決済を記録"}
          </button>
          {owner && !ownerPreview.plan && (
            <p className="field-error">
              精算する金額と口座を入力し、充当内訳を確認してください。
              {ownerPreview.error
                ? "上の確認事項を解消すると記録できます。"
                : "内訳を取得するまで記録できません。"}
            </p>
          )}
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
                toAccountRevision: rows.find((a) => a.id === current.toAccountId)?.revision ?? 0,
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
