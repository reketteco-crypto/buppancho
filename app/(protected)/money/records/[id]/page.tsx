import { moneyDisplayScope, moneyReturnHref } from "@/lib/commerce/money-navigation";
import { ListBackLink } from "@/components/list-display-state";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { OtherRecordEditor } from "@/components/commerce/other-form";
import { SettlementSection } from "@/components/commerce/settlement-section";
export default async function OtherDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const c = await commerceContext(),
    { id } = await params,
    r = await c.db.otherRecord.findFirstOrThrow({
      where: {
        id,
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        reportingEntityId: c.reportingEntityId,
      },
      include: { reversedBy: true, reverses: true },
    });
  const returnTo = moneyReturnHref((await searchParams).returnTo),
    scope = moneyDisplayScope(c);
  const incoming = (r.kind === "INCOME") !== r.amountJpy < 0n;
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>{r.categoryName}</h1>
        <span className="commerce-secondary">{r.date.toISOString().slice(0, 10)}</span>
      </header>
      <div className="commerce-editor">
        <p className="commerce-total">¥{r.amountJpy.toLocaleString("ja-JP")}</p>
        {r.counterparty && <p>{r.counterparty}</p>}
        {r.memo && <p>{r.memo}</p>}
        {r.sourceSaleId && (
          <Link className="commerce-text-button" href={`/sales/orders/${r.sourceSaleId}`}>
            関連する販売
          </Link>
        )}
        {r.sourcePurchaseId && (
          <Link className="commerce-text-button" href={`/purchases/${r.sourcePurchaseId}`}>
            関連する購入
          </Link>
        )}
        {!r.reversedBy && (
          <SettlementSection
            c={c}
            returnTo={returnTo}
            kind={incoming ? "OTHER_RECEIPT" : "OTHER_PAYMENT"}
            id={r.id}
          />
        )}
        {r.reversedBy ? (
          <Link className="commerce-text-button" href={`/money/records/${r.reversedBy.id}`}>
            取消の記録
          </Link>
        ) : (
          !r.reverses && (
            <details className="commerce-disclosure">
              <summary>この収支を取り消す</summary>
              <OtherRecordEditor
                returnTo={returnTo}
                accounts={[]}
                categories={[]}
                initial={{
                  context: c.context,
                  idempotencyKey: randomUUID(),
                  date: todayTokyo(),
                  kind: r.kind as "EXPENSE" | "INCOME",
                  amount: "0",
                  categoryId: r.categoryId,
                  categoryName: r.categoryName,
                  counterparty: r.counterparty || "",
                  memo: "",
                  settled: false,
                  accountId: "",
                  accountRevision: 0,
                  reversesId: r.id,
                }}
              />
            </details>
          )
        )}
        {returnTo ? (
          <Link className="commerce-text-button" href={returnTo} scroll={false}>
            お金の一覧へ
          </Link>
        ) : (
          <ListBackLink context={scope} className="commerce-text-button" href="/money?tab=records">
            お金の一覧へ
          </ListBackLink>
        )}
      </div>
    </div>
  );
}
