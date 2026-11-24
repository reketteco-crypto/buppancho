"use client";
import { useState } from "react";
import type { AccountChoice } from "./money-form";
import { accountBalanceView } from "@/lib/commerce/account-label";
import { SearchSelect } from "./ui";
export function PaymentAccount({
  accounts,
  id,
  onChange,
  label = "口座",
  name = "accountId",
}: {
  accounts: AccountChoice[];
  id: string;
  onChange: (id: string, revision: number) => void;
  label?: string;
  name?: string;
}) {
  return (
    <SearchSelect
      limit={accounts.length || 50}
      label={label}
      name={name}
      required
      value={id}
      options={accounts.map((a) => {
        const balance = accountBalanceView(a.accountKind ?? "STANDARD", BigInt(a.balance));
        return {
          id: a.id,
          label: `${a.name} · ${a.accountKind === "CREDIT_CARD" ? `${balance.label} ` : ""}¥${balance.amount.toLocaleString("ja-JP")}`,
        };
      })}
      onChange={(next) => onChange(next, accounts.find((a) => a.id === next)?.revision ?? 0)}
    />
  );
}

export function usePaymentAccounts(initial: AccountChoice[], context: object) {
  const [accounts, setAccounts] = useState(initial),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const refresh = async (onChange: (accounts: AccountChoice[]) => void) => {
    setBusy(true);
    try {
      const response = await fetch("/api/commerce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accounts", kind: "MONEY_RECORD", payload: { context } }),
      });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.accounts))
        throw new Error(result.error || "口座情報を確認できません。入力は保持しています。");
      setAccounts(result.accounts);
      onChange(result.accounts);
      setMessage("口座情報を更新しました。内容を確認して保存してください。");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "口座情報を確認できません。入力は保持しています。",
      );
    } finally {
      setBusy(false);
    }
  };
  return { accounts, busy, message, refresh };
}
