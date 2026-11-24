import { accountBalanceView } from "@/lib/commerce/account-label";
import { randomUUID } from "node:crypto";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { AccountEditor } from "@/components/commerce/money-form";
export default async function AccountsSettings() {
  const c = await commerceContext(),
    rows = await c.db.moneyAccount.findMany({
      where: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        reportingEntityId: c.reportingEntityId,
        accountKind: { not: "OWNER_CLEARING" },
      },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
    base = { context: c.context, date: todayTokyo() };
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>口座</h1>
      </header>
      <div className="commerce-editor">
        {rows.map((a) => (
          <details className="commerce-disclosure" key={`${a.id}:${a.revision}`}>
            <summary>
              {a.name}
              {!a.active ? " · 無効" : ""}
            </summary>
            <p className="commerce-secondary">
              開始 {a.openingDate.toISOString().slice(0, 10)} ·{" "}
              {accountBalanceView(a.accountKind, a.openingBalanceJpy).label} ¥
              {accountBalanceView(a.accountKind, a.openingBalanceJpy).amount.toLocaleString(
                "ja-JP",
              )}
            </p>
            <AccountEditor
              initial={{
                ...base,
                idempotencyKey: randomUUID(),
                id: a.id,
                revision: a.revision,
                name: a.name,
                accountKind: a.accountKind as "STANDARD" | "CREDIT_CARD",
                balance: a.openingBalanceJpy.toString(),
                active: a.active,
              }}
            />
          </details>
        ))}
        <details className="commerce-disclosure">
          <summary>口座を追加</summary>
          <AccountEditor
            initial={{
              ...base,
              idempotencyKey: randomUUID(),
              id: "",
              revision: 0,
              name: "",
              balance: "0",
              active: true,
            }}
          />
        </details>
      </div>
    </div>
  );
}
