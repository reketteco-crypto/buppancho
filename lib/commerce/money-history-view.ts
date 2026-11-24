import { moneyLabels } from "./money-labels";

export type HistoryEntry = {
  id: string;
  accountId: string;
  amountJpy: bigint;
  purpose: string;
  account: { name: string; accountKind: string };
};
export type HistoryTransaction = {
  id: string;
  kind: string;
  amountJpy: bigint;
  feeJpy: bigint;
  date: Date;
  memo: string | null;
  entries: HistoryEntry[];
  reversesId: string | null;
  reversedBy: { id: string } | null;
  reverses: { kind: string } | null;
};
export type MoneyHistoryRow = {
  id: string;
  type: "entry" | "record";
  date: string;
  title: string;
  kindLabel: string;
  reference: string;
  flow: string;
  amount: string;
  amountLabel: string;
  feeLabel: string;
  status: string;
  memo: string;
  relatedHref: string;
  principal: string;
  fee: string;
  canCancel: boolean;
  entries: { id: string; name: string; amount: string; label: string }[];
};
export const yenText = (value: bigint) => `¥${value.toLocaleString("ja-JP")}`;
export const signedYen = (value: bigint) =>
  `${value > 0n ? "＋" : value < 0n ? "−" : ""}${yenText(value < 0n ? -value : value)}`;

function accountOperation(entry: HistoryEntry, kind: string, reversal: boolean) {
  if (
    entry.account.accountKind === "OWNER_CLEARING" &&
    ["OWNER_REIMBURSEMENT", "OWNER_REPAYMENT"].includes(kind)
  )
    return `${kind === "OWNER_REIMBURSEMENT" ? "立替精算" : "差額返還"}${reversal ? "の取消" : ""}`;
  if (entry.account.accountKind === "OWNER_CLEARING") {
    const originalSign = reversal ? -entry.amountJpy : entry.amountJpy;
    return `${originalSign < 0n ? "本人立替" : "本人受取"}${reversal ? "の取消" : ""}`;
  }
  if (entry.account.accountKind === "CREDIT_CARD") {
    const originalSign = reversal ? -entry.amountJpy : entry.amountJpy;
    const operation =
      kind === "TRANSFER"
        ? originalSign > 0n
          ? "引落"
          : "振替"
        : originalSign < 0n
          ? "利用"
          : "返金";
    return reversal ? `${operation}の取消` : operation;
  }
  return "";
}

export function transactionHistoryRow(
  t: HistoryTransaction,
  source: { title: string; reference: string; href: string },
  accountId?: string,
): MoneyHistoryRow {
  const kind = t.reverses?.kind ?? t.kind;
  const reversal = !!t.reversesId;
  const principals = t.entries.filter((e) => e.purpose === "PRINCIPAL");
  const selected = accountId ? t.entries.filter((e) => e.accountId === accountId) : t.entries;
  const selectedPrincipal = principals.find((e) => e.accountId === accountId);
  const from = principals.find((e) => e.amountJpy < 0n);
  const to = principals.find((e) => e.amountJpy > 0n);
  const transfer = kind === "TRANSFER";
  const visible =
    selectedPrincipal ??
    principals.find((e) => e.account.accountKind === "STANDARD") ??
    principals[0];
  const operation = visible ? accountOperation(visible, kind, reversal) : "";
  const amounts =
    !accountId && !transfer && visible
      ? selected.filter((e) => e.accountId === visible.accountId)
      : selected;
  const sum = amounts.reduce((total, e) => total + e.amountJpy, 0n);
  const card = principals.find((e) => e.account.accountKind === "CREDIT_CARD");
  const amountLabel = accountId
    ? operation
    : transfer
      ? card
        ? accountOperation(card, kind, reversal)
        : reversal
          ? "振替取消"
          : "振替"
      : operation;
  const amount = amountLabel
    ? yenText(accountId ? (sum < 0n ? -sum : sum) : t.amountJpy)
    : signedYen(sum);
  const flow =
    principals.length > 1
      ? `${from?.account.name ?? "口座未確認"} → ${to?.account.name ?? "口座未確認"}`
      : (principals[0]?.account.name ?? "口座未確認");
  return {
    id: t.id,
    type: "entry",
    date: t.date.toISOString().slice(0, 10),
    title: source.title,
    reference: source.reference,
    relatedHref: source.href,
    kindLabel: `${moneyLabels[kind] ?? "入出金"}${reversal ? "の取消" : ""}`,
    flow,
    amount,
    amountLabel,
    feeLabel: t.feeJpy > 0n ? `${reversal ? "手数料の取消" : "手数料"} ${yenText(t.feeJpy)}` : "",
    status: t.reversedBy ? "取消済み" : reversal ? "取消" : "",
    memo: t.memo ?? "",
    principal: t.amountJpy.toString(),
    fee: t.feeJpy.toString(),
    canCancel: !t.reversedBy && !t.reversesId,
    entries: t.entries.map((e) => {
      const label = accountOperation(e, kind, reversal);
      return {
        id: e.id,
        name: e.account.name,
        amount: label
          ? yenText(e.amountJpy < 0n ? -e.amountJpy : e.amountJpy)
          : signedYen(e.amountJpy),
        label: e.purpose === "FEE" ? (reversal ? "手数料の取消" : "手数料") : label,
      };
    }),
  };
}

export function otherSettlementStatus(target: bigint, paid: bigint, cancelled: boolean) {
  if (cancelled) return "取消済み";
  if (paid > target) return "差額確認";
  if (target === 0n) return "決済不要";
  if (paid === target) return "決済済み";
  return paid > 0n ? "一部決済" : "未決済";
}
