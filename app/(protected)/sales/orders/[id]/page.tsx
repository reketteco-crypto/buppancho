import { notFound, redirect } from "next/navigation";
import { GenericSaleDetail } from "@/components/commerce/sale-detail";
import Link from "next/link";
import { ListBackLink } from "@/components/list-display-state";
import { AmountAmendForm } from "@/components/forms/workflow-forms";
import { inputContext } from "@/lib/sales/workflow-view";
import { requireInventoryContext } from "@/lib/inventory/context";
import { formatYen } from "@/lib/inventory/money";
import { managementProfit } from "@/lib/sales/money";
import { effectiveCosts } from "@/lib/inventory/effective-cost";
import { effectiveSourceDates } from "@/lib/inventory/event-dates";
import { tokyoLocalInput } from "@/lib/sales/view";
import { transactionScope } from "@/lib/commerce/scope";
import { salesListScope } from "@/lib/commerce/sales-list";
const labels: Record<string, string> = {
  AWAITING_SHIPMENT: "発送待ち",
  SHIPPED: "発送済み",
  AWAITING_COMPLETION: "取引完了待ち",
  COMPLETED: "完了",
  CANCELLED: "キャンセル",
  RETURNED: "返品",
};
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ return?: string }>;
}) {
  const { id } = await params;
  const context = await requireInventoryContext();
  const order = await context.db.salesOrder.findFirst({
    where: { id, ...transactionScope(context) },
    include: {
      salesChannel: true,
      shipment: true,
      lines: {
        include: {
          salesSku: {
            include: {
              components: {
                include: {
                  itemVariant: { include: { inventoryItem: true } },
                  uniqueStockUnit: {
                    include: { itemVariant: { include: { inventoryItem: true } } },
                  },
                },
              },
            },
          },
          reservations: true,
          consumptions: {
            include: { itemVariant: { include: { inventoryItem: true } }, uniqueStockUnit: true },
          },
        },
      },
      events: { include: { operator: true }, orderBy: { occurredAt: "desc" } },
      returns: {
        include: { lines: { include: { dispositions: true } } },
        orderBy: { returnedAt: "desc" },
      },
    },
  });
  if (!order) notFound();
  if (order.recordingMode === "DIRECT") return <GenericSaleDetail id={id} />;
  if (!order.completionListingId) redirect("/sales?view=completed");
  const stockEvents = await context.db.inventoryOperation.findMany({
    where: {
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      OR: [
        { sourceType: "sales_order", sourceId: order.id, operationType: "SALE_COMPLETION" },
        { sourceType: "sales_return", sourceId: { in: order.returns.map((r) => r.id) } },
      ],
    },
  });
  const returnDates = await effectiveSourceDates(
    context.db,
    { workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
    "sales_return",
    order.returns.map((r) => ({ id: r.id, date: r.returnedAt })),
  );
  const completedDates = await effectiveSourceDates(
    context.db,
    { workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
    "sales_order",
    order.completedAt ? [{ id: order.id, date: order.completedAt }] : [],
  );
  const query = await searchParams;
  const recorded = order.returns.find((r) => r.id === query.return);
  const drafts = await context.db.workflowDraft.findMany({
    where: {
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      operatorId: context.operatorId,
      year: context.fiscalYear.year,
      kind: { in: ["RETURN", "REFUND"] },
      archivedAt: null,
      payload: { path: ["orderId"], equals: id },
    },
    orderBy: { updatedAt: "desc" },
  });
  const changes = await context.db.workflowEvent.findMany({
    where: {
      targetId: id,
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      kind: { in: ["AMEND", "REFUND"] },
    },
    orderBy: { createdAt: "desc" },
  });
  const returnCosts = await effectiveCosts(
    context.db,
    "DISPOSITION",
    order.returns.flatMap((r) => r.lines.flatMap((l) => l.dispositions)),
  );
  const corrections = await context.db.valuationAdjustment.findMany({
    where: {
      targetType: "CONSUMPTION",
      targetId: { in: order.lines.flatMap((l) => l.consumptions.map((x) => x.id)) },
      run: { workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
    },
    include: { run: true },
    orderBy: { run: { sequence: "asc" } },
  });
  const cogs = order.lines.reduce((s, row) => s + (row.managementCogsJpy ?? 0n), 0n);
  const salesRefund = order.returns.reduce((s, row) => s + row.salesRefundJpy, 0n),
    feeRefund = order.returns.reduce((s, row) => s + row.feeRefundJpy, 0n),
    shippingRefund = order.returns.reduce((s, row) => s + row.shippingRefundJpy, 0n),
    restocked = order.returns
      .flatMap((row) => row.lines)
      .flatMap((row) => row.dispositions)
      .filter((row) => row.disposition === "RESTOCK")
      .reduce((s, row) => s + returnCosts.get(row.id)!, 0n);
  const profit = managementProfit({
    gross: order.grossSalesJpy,
    discount: order.discountJpy,
    fee: order.feeJpy,
    shipping: order.shippingJpy,
    packing: order.packingJpy,
    other: order.otherCostJpy,
    cogs,
    salesRefund,
    feeRefund,
    shippingRefund,
    restockedCost: restocked,
  });
  const today = tokyoLocalInput();
  const amountsKnown =
    order.costStatus === "FINAL" &&
    order.lines.every((l) => l.managementCogsJpy !== null) &&
    [order.feeJpy, order.shippingJpy, order.packingJpy, order.otherCostJpy].every(
      (v) => v !== null,
    );
  return (
    <div className="page">
      <ListBackLink
        context={salesListScope(context, context.fiscalYear.year)}
        href="/sales?view=completed"
      >
        完了実績の一覧へ
      </ListBackLink>
      <header className="page-header">
        <div>
          <p className="eyebrow">{order.salesChannel.name}</p>
          <h1>{order.lines.map((row) => row.displayName ?? row.salesSku.name).join("、")}</h1>
          <p className="muted">
            {labels[order.status] ?? order.status}・{order.externalOrderId || "外部注文IDなし"}
          </p>
        </div>
        <span className="status-chip">{labels[order.status] ?? order.status}</span>
      </header>
      <div className="metric-grid">
        <div className="card metric">
          <span>総売上</span>
          <strong>¥{formatYen(order.grossSalesJpy)}</strong>
        </div>
        <div className="card metric">
          <span>管理原価</span>
          <strong>
            {order.status === "COMPLETED" || order.status === "RETURNED"
              ? `¥${formatYen(cogs)}`
              : "完了時に確定"}
          </strong>
        </div>
        <div className="card metric">
          <span>{amountsKnown ? "管理利益" : "金額要確認"}</span>
          <strong>{amountsKnown ? `¥${formatYen(profit)}` : "計算に必要な情報が不足"}</strong>
        </div>
        <div className="card metric">
          <span>数量</span>
          <strong>{order.lines.reduce((s, row) => s + row.quantity, 0)}</strong>
        </div>
      </div>
      {order.completionListingId && (
        <p>
          <Link href={`/sales/listings/${order.completionListingId}`}>
            元の出品・価格履歴を確認する
          </Link>
        </p>
      )}
      {order.completedAt && (
        <section className="card">
          <h2>完了記録</h2>
          {stockEvents
            .filter((e) => e.sourceType === "sales_order")
            .map((e) => (
              <p key={e.id}>
                <Link href={`/inventory/events/${e.id}/date`}>完了日を訂正する</Link>
              </p>
            ))}
          <p>
            完了日：{completedDates.get(order.id)}
            。確保在庫は出庫済みです。金額の補完では在庫を再度減らしません。
          </p>
          <details open={!amountsKnown}>
            <summary>金額を確認・補完する</summary>
            <AmountAmendForm
              key={order.revision}
              context={inputContext(context)}
              orderId={order.id}
              revision={order.revision}
              today={today.slice(0, 10)}
              initial={{
                actualPrice: order.grossSalesJpy.toString(),
                fee: order.feeJpy?.toString() ?? "",
                shipping: order.shippingJpy?.toString() ?? "",
                packing: order.packingJpy?.toString() ?? "",
                other: order.otherCostJpy?.toString() ?? "",
              }}
            />
          </details>
        </section>
      )}
      {recorded && (
        <section role="status" className="message success">
          <h2>今回の返品・返金を記録しました</h2>
          <p>
            売上返金 ¥{formatYen(recorded.salesRefundJpy)}・手数料返還 ¥
            {formatYen(recorded.feeRefundJpy)}・送料返還 ¥{formatYen(recorded.shippingRefundJpy)}
          </p>
          <p>
            販売可能在庫へ戻した数{" "}
            {recorded.lines
              .flatMap((l) => l.dispositions)
              .filter((d) => d.disposition === "RESTOCK")
              .reduce((s, d) => s + d.quantity, 0)}
            個／販売不可{" "}
            {recorded.lines
              .flatMap((l) => l.dispositions)
              .filter((d) => d.disposition === "DEFECTIVE")
              .reduce((s, d) => s + d.quantity, 0)}
            個／廃棄{" "}
            {recorded.lines
              .flatMap((l) => l.dispositions)
              .filter((d) => d.disposition === "DISPOSED")
              .reduce((s, d) => s + d.quantity, 0)}
            個
          </p>
        </section>
      )}
      {order.completedAt && (
        <section className="card">
          <h2>返品・返金の記録</h2>
          <div className="button-row">
            <Link className="button secondary" href={`/sales/orders/${id}/return?kind=RETURN`}>
              返品を記録
            </Link>
            <Link className="button secondary" href={`/sales/orders/${id}/return?kind=REFUND`}>
              在庫を変えずに返金を記録
            </Link>
          </div>
          {drafts.map((d) => (
            <p key={d.id}>
              <Link href={`/sales/orders/${id}/return?kind=${d.kind}&draft=${d.id}`}>
                {d.kind === "RETURN" ? "返品" : "返金"}の途中保存から再開
              </Link>
            </p>
          ))}
        </section>
      )}
      {!!order.returns.length && (
        <section className="card">
          <h2>返品・返金履歴</h2>
          {order.returns.map((r) => (
            <div key={r.id}>
              <p>
                {returnDates.get(r.id)} ／ 売上返金 ¥{formatYen(r.salesRefundJpy)}・手数料返還 ¥
                {formatYen(r.feeRefundJpy)}・送料返還 ¥{formatYen(r.shippingRefundJpy)}
              </p>
              <p>{r.memo}</p>
              {stockEvents
                .filter((e) => e.sourceType === "sales_return" && e.sourceId === r.id)
                .map((e) => (
                  <p key={e.id}>
                    <Link href={`/inventory/events/${e.id}/date`}>返品処理日を訂正する</Link>
                  </p>
                ))}
              <ul>
                {r.lines
                  .flatMap((l) => l.dispositions)
                  .map((d) => (
                    <li key={d.id}>
                      {d.disposition === "RESTOCK"
                        ? "良品戻し"
                        : d.disposition === "DEFECTIVE"
                          ? "不良品"
                          : "廃棄"}{" "}
                      {d.quantity}個・訂正反映後原価 ¥{formatYen(returnCosts.get(d.id)!)}（当初 ¥
                      {formatYen(d.costTotalJpy)}）
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {corrections.length > 0 && (
        <section className="card">
          <h2>管理原価の訂正履歴</h2>
          <p>元の販売数量・当初原価は変更していません。利益は訂正反映後の原価を使用します。</p>
          {corrections.map((x) => (
            <p key={x.id}>
              {x.run.createdAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}：¥
              {formatYen(x.beforeJpy)} → ¥{formatYen(x.afterJpy)}（差額 ¥{formatYen(x.deltaJpy)}）{" "}
              <Link href={`/sales/orders/${x.run.sourceOrderId}`}>原因の完了実績</Link>
            </p>
          ))}
        </section>
      )}
      <section className="card">
        <h2>明細</h2>
        <ul className="activity-list">
          {order.lines.map((row) => (
            <li key={row.id}>
              <span>
                <strong>
                  {row.salesSku.skuCode} {row.displayName ?? row.salesSku.name}
                </strong>
                <span>
                  {row.quantity}販売単位 × ¥{formatYen(row.unitPriceJpy)}・販売単位での返品{" "}
                  {row.returnedQuantity}
                  {order.returns.some((r) =>
                    r.lines.some((l) => l.salesOrderLineId === row.id && l.componentOnly),
                  ) && "（構成品ごとの処理は返品履歴を参照）"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {!!changes.length && (
        <section className="card">
          <h2>金額の追記・訂正履歴</h2>
          {changes.map((event) => {
            const detail = event.detail as {
              request: {
                reason?: string;
                actualPrice?: string;
                fee?: string | null;
                shipping?: string | null;
                packing?: string | null;
                other?: string | null;
              };
              result: {
                before?: {
                  gross: string;
                  fee: string | null;
                  shipping: string | null;
                  packing: string | null;
                  other: string | null;
                };
              };
            };
            const amount = (value: string | null | undefined) =>
              value == null ? "未確認" : `¥${formatYen(BigInt(value))}`;
            return (
              <div key={event.id}>
                <p>
                  {event.occurredAt.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}・
                  {event.kind === "AMEND" ? "金額補完・訂正" : "返金"}：{detail.request.reason}
                </p>
                {detail.result.before && (
                  <ul>
                    {(
                      [
                        ["売上", "gross", "actualPrice"],
                        ["手数料", "fee", "fee"],
                        ["送料", "shipping", "shipping"],
                        ["梱包費", "packing", "packing"],
                        ["その他", "other", "other"],
                      ] as const
                    ).map(([label, before, after]) => (
                      <li key={before}>
                        {label}：{amount(detail.result.before![before])} →{" "}
                        {amount(detail.request[after])}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="muted">
                  入力日時 {event.createdAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                  ・在庫変更なし
                </p>
              </div>
            );
          })}
        </section>
      )}
      <section className="card">
        <h2>状態履歴</h2>
        <ul className="activity-list">
          {order.events.map((row) => (
            <li key={row.id}>
              <span>
                <strong>{labels[row.toStatus] ?? row.toStatus}</strong>
                <span>
                  {row.occurredAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}・
                  {row.operator.displayName}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
