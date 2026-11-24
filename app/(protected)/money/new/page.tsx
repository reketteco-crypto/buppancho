import { randomUUID } from "node:crypto";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { accountBalances } from "@/lib/commerce/money";
import { OtherRecordEditor } from "@/components/commerce/other-form";
export default async function NewOther({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; sale?: string; returnTo?: string }>;
}) {
  const c = await commerceContext(),
    q = await searchParams,
    kind = q.kind === "INCOME" ? "INCOME" : "EXPENSE";
  if (
    q.sale &&
    !(await c.db.salesOrder.findFirst({
      where: {
        id: q.sale,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        reportingEntityId: c.reportingEntityId,
      },
    }))
  )
    throw new Error("関連する販売を確認してください。");
  const accounts = (await accountBalances(c.db, c)).filter((a) => a.active),
    categories = await c.db.moneyCategory.findMany({
      where: { workspaceId: c.workspaceId, active: true },
      orderBy: { name: "asc" },
    });
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>{kind === "EXPENSE" ? "費用を記録" : "収入を記録"}</h1>
      </header>
      <p className="commerce-caption">
        {q.sale
          ? "この販売に関連する追加費用を記録します。"
          : kind === "EXPENSE"
            ? "購入や販売に結び付かない経費を記録します。仕入の支払は購入詳細、売上の入金は販売詳細から記録してください。"
            : "商品の販売以外の収入を記録します。売上の入金は販売詳細から記録してください。"}
      </p>
      <OtherRecordEditor
        returnTo={q.returnTo}
        accounts={accounts.map((a) => ({
          id: a.id,
          name: a.name,
          revision: a.revision,
          balance: a.balance.toString(),
          accountKind: a.accountKind,
        }))}
        categories={categories.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          revision: c.revision,
        }))}
        initial={{
          context: c.context,
          idempotencyKey: randomUUID(),
          date: todayTokyo(),
          kind,
          amount: "",
          categoryId: "",
          categoryName: q.sale ? "再送料" : "",
          sourceSaleId: q.sale,
          counterparty: "",
          memo: "",
          settled: accounts.length > 0,
          accountId: accounts[0]?.id || "",
          accountRevision: accounts[0]?.revision || 0,
        }}
      />
    </div>
  );
}
