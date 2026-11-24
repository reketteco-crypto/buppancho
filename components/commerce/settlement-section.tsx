import { randomUUID } from "node:crypto";
import type { commerceContext } from "@/lib/commerce/view";
import { todayTokyo } from "@/lib/commerce/view";
import { accountBalances, settlementSource, type SettlementKind } from "@/lib/commerce/money";
import { MoneyEditor } from "./money-form";
export async function SettlementSection({
  c,
  kind,
  id,
  label,
  hideEmpty = false,
  returnTo,
}: {
  c: Awaited<ReturnType<typeof commerceContext>>;
  kind: SettlementKind;
  id: string;
  label?: string;
  hideEmpty?: boolean;
  returnTo?: string;
}) {
  const scope = {
    workspaceId: c.workspaceId,
    businessUnitId: c.businessUnitId,
    reportingEntityId: c.reportingEntityId,
  };
  const accounts = await accountBalances(c.db, scope);
  const current = await c.db.$transaction((tx) =>
    settlementSource(
      tx,
      {
        ...scope,
        userAccountId: c.session.userAccountId,
        operatorId: c.operatorId,
        year: c.fiscalYear.year,
      },
      kind,
      id,
    ),
  );
  const payments = await c.db.moneyTransaction.findMany({
    where: { ...scope, kind, sourceId: { in: current.sourceIds }, reversedBy: null },
    include: { entries: { include: { account: true } } },
    orderBy: { date: "asc" },
  });
  const paid = payments.reduce((s, t) => s + t.amountJpy, 0n),
    remaining = current.amount === null ? null : current.amount - paid;
  if (hideEmpty && (current.amount === 0n || current.amount === null) && !payments.length)
    return null;
  const preferred =
    accounts.find((a) => a.active && a.id === current.receivingAccountId) ??
    accounts.find((a) => a.active);
  return (
    // Native disclosure state can change while the child form is loading.
    <details className="commerce-disclosure" suppressHydrationWarning>
      <summary>
        {label ?? (current.incoming ? "入金" : "支払")}
        <span>
          {remaining === null
            ? "金額未確認"
            : remaining < 0n
              ? `差額確認 ¥${(-remaining).toLocaleString("ja-JP")}`
              : remaining === 0n
                ? "決済済み"
                : `未決済 ¥${remaining.toLocaleString("ja-JP")}`}
        </span>
      </summary>
      <p className="commerce-caption">
        {current.incoming
          ? "この取引に結び付けて入金を記録し、受取先の残高へ反映します。"
          : "この取引に結び付けて支払を記録し、支払元の残高へ反映します。"}
      </p>
      {payments.map((t) => (
        <div className="commerce-summary-line" key={t.id}>
          <span>
            {t.date.toISOString().slice(0, 10)} · {t.entries[0]?.account.name}
          </span>
          <span>¥{t.amountJpy.toLocaleString("ja-JP")}</span>
        </div>
      ))}
      {remaining !== null && remaining > 0n && (
        <MoneyEditor
          returnTo={returnTo}
          key={`${current.revision}:${accounts.map((a) => `${a.id}:${a.revision}`).join(",")}`}
          accounts={accounts
            .filter((a) => a.active)
            .map((a) => ({
              id: a.id,
              name: a.name,
              revision: a.revision,
              balance: a.balance.toString(),
              accountKind: a.accountKind,
            }))}
          initial={{
            context: c.context,
            idempotencyKey: randomUUID(),
            date: todayTokyo(),
            kind,
            amount: remaining.toString(),
            fee: "",
            accountId: preferred?.id || "",
            accountRevision: preferred?.revision || 0,
            toAccountId: "",
            toAccountRevision: 0,
            sourceId: id,
            sourceRevision: current.revision,
            memo: "",
          }}
        />
      )}
    </details>
  );
}
