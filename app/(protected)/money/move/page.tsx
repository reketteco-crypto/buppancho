import { randomUUID } from "node:crypto";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { accountBalances } from "@/lib/commerce/money";
import { MoneyEditor } from "@/components/commerce/money-form";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ card?: string; kind?: string; returnTo?: string }>;
}) {
  const c = await commerceContext(),
    query = await searchParams,
    accounts = (await accountBalances(c.db, c)).filter((a) => a.active),
    card = accounts.find((a) => a.accountKind === "CREDIT_CARD" && a.id === query.card);
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>{card ? "カード引落を記録" : "資金移動"}</h1>
      </header>
      <div className="commerce-editor">
        <MoneyEditor
          returnTo={query.returnTo}
          movement
          accounts={accounts.map((a) => ({ ...a, balance: a.balance.toString() }))}
          initial={{
            context: c.context,
            idempotencyKey: randomUUID(),
            date: todayTokyo(),
            kind:
              query.kind === "OWNER_REIMBURSEMENT" || query.kind === "OWNER_REPAYMENT"
                ? query.kind
                : "TRANSFER",
            accountId: "",
            accountRevision: 0,
            toAccountId: card?.id ?? "",
            toAccountRevision: card?.revision ?? 0,
            amount: "",
            fee: "0",
            memo: "",
          }}
        />
      </div>
    </div>
  );
}
