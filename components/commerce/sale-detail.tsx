import { randomUUID } from "node:crypto";
import { supplyPrices } from "@/lib/commerce/supplies";
import { MaterialUseEditor } from "./material-use-form";
import { SettlementSection } from "./settlement-section";
import Link from "next/link";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { managementProfit } from "@/lib/sales/money";
import { effectiveCosts } from "@/lib/inventory/effective-cost";
import { effectiveSourceDates } from "@/lib/inventory/event-dates";
import { AmountAmendForm } from "@/components/forms/workflow-forms";
import { transactionScope } from "@/lib/commerce/scope";
import { notFound } from "next/navigation";
import { ListBackLink } from "@/components/list-display-state";
import { salesListScope } from "@/lib/commerce/sales-list";
import { saleSourceSchema } from "@/lib/commerce/sale-source";

export async function GenericSaleDetail({ id }: { id: string }) {
  const c = await commerceContext();
  const order = await c.db.salesOrder.findFirst({
    where: { id, ...transactionScope(c) },
    include: {
      salesChannel: true,
      materialUses: { include: { supersededBy: true }, orderBy: { createdAt: "asc" } },
      lines: true,
      returns: { include: { lines: { include: { dispositions: true } } } },
    },
  });
  if (!order) notFound();
  const source = saleSourceSchema.safeParse(
    (order.saleSnapshot as { importSource?: unknown } | null)?.importSource,
  );
  const [completedDates, returnDates, dateOperations] = await Promise.all([
    effectiveSourceDates(
      c.db,
      c,
      "sales_order",
      order.completedAt ? [{ id: order.id, date: order.completedAt }] : [],
    ),
    effectiveSourceDates(
      c.db,
      c,
      "sales_return",
      order.returns.map((r) => ({ id: r.id, date: r.returnedAt })),
    ),
    c.db.inventoryOperation.findMany({
      where: {
        workspaceId: c.workspaceId,
        businessUnitId: c.businessUnitId,
        OR: [
          { sourceType: "sales_order", sourceId: order.id, operationType: "SALE_COMPLETION" },
          { sourceType: "sales_return", sourceId: { in: order.returns.map((r) => r.id) } },
        ],
      },
    }),
  ]);
  const completedDate = completedDates.get(order.id);
  const returned = await effectiveCosts(
    c.db,
    "DISPOSITION",
    order.returns.flatMap((r) => r.lines.flatMap((l) => l.dispositions)),
  );
  const cogs = order.lines.every((l) => l.managementCogsJpy !== null)
    ? order.lines.reduce((s, l) => s + l.managementCogsJpy!, 0n)
    : null;
  const baseProfit =
    cogs === null ||
    order.costStatus !== "FINAL" ||
    [order.feeJpy, order.shippingJpy, order.packingJpy, order.otherCostJpy].some((v) => v === null)
      ? null
      : managementProfit({
          gross: order.grossSalesJpy,
          discount: order.discountJpy,
          fee: order.feeJpy!,
          shipping: order.shippingJpy!,
          packing: order.packingJpy!,
          other: order.otherCostJpy!,
          cogs,
          salesRefund: order.returns.reduce((s, r) => s + r.salesRefundJpy, 0n),
          feeRefund: order.returns.reduce((s, r) => s + r.feeRefundJpy, 0n),
          shippingRefund: order.returns.reduce((s, r) => s + r.shippingRefundJpy, 0n),
          restockedCost: order.returns
            .flatMap((r) => r.lines.flatMap((l) => l.dispositions))
            .filter((d) => d.disposition === "RESTOCK")
            .reduce((s, d) => s + returned.get(d.id)!, 0n),
        });
  const activeUses = order.materialUses.filter((u) => !u.supersededBy),
    materialCost = activeUses.some((u) => u.costJpy === null)
      ? null
      : activeUses.reduce((sum, u) => sum + u.costJpy!, 0n);
  const extras = await c.db.otherRecord.findMany({
    where: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      reportingEntityId: order.reportingEntityId,
      sourceSaleId: order.id,
    },
  });
  const extraExpense = extras
      .filter((r) => r.kind === "EXPENSE")
      .reduce((s, r) => s + r.amountJpy, 0n),
    extraIncome = extras.filter((r) => r.kind === "INCOME").reduce((s, r) => s + r.amountJpy, 0n);
  const profit =
    baseProfit === null || materialCost === null || activeUses.some((u) => !u.costFinal)
      ? null
      : baseProfit - materialCost - extraExpense + extraIncome;
  const editable = order.reportingEntityId === c.reportingEntityId;
  const supplies = editable
    ? (await supplyPrices(c.db, c, todayTokyo())).filter((s) => s.kind === "MATERIAL")
    : [];
  const rule = order.settlementSnapshot as {
    feeDeducted: boolean;
    shippingDeducted: boolean;
  } | null;
  const money = (v: bigint | null) => (v === null ? "未確認" : `¥${v.toLocaleString("ja-JP")}`);
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <div>
          <p className="commerce-overline">
            {completedDate?.replaceAll("-", "/")} · {order.salesChannel.name}
          </p>
          <h1>{order.lines.map((l) => l.displayName).join("、")}</h1>
        </div>
        <span className="commerce-badge">記録済み</span>
      </header>
      <div className="commerce-editor">
        <div className="commerce-account-grid">
          <div className="commerce-account">
            <span className="commerce-secondary">売上</span>
            <strong>{money(order.grossSalesJpy)}</strong>
          </div>
          <div className="commerce-account">
            <span className="commerce-secondary">
              {profit === null ? "利益・確認待ち" : "商品別利益"}
            </span>
            <strong>{profit === null ? "—" : money(profit)}</strong>
          </div>
        </div>
        {[
          ["販売数量", `${order.lines.reduce((s, l) => s + l.quantity, 0)} 点`],
          ["販売手数料", money(order.feeJpy)],
          ["送料", money(order.shippingJpy)],
          ["商品原価", money(cogs)],
          [
            "資材・梱包費",
            money(
              materialCost === null || order.packingJpy === null
                ? null
                : materialCost + order.packingJpy,
            ),
          ],
          [
            "その他費用",
            money(
              order.otherCostJpy === null ? null : order.otherCostJpy + extraExpense - extraIncome,
            ),
          ],
        ].map(([name, value]) => (
          <div className="commerce-summary-line" key={name}>
            <span>{name}</span>
            <span>{value}</span>
          </div>
        ))}
        {editable && rule && (
          <section className="commerce-section">
            <SettlementSection c={c} kind="SALE_RECEIPT" id={id} label="売上の入金" />
            <SettlementSection
              c={c}
              kind="SALE_SETTLEMENT_PAYMENT"
              id={id}
              label="差引精算の支払"
              hideEmpty
            />
            {!rule.feeDeducted && (
              <SettlementSection c={c} kind="FEE_PAYMENT" id={id} label="販売手数料の支払" />
            )}
            {!rule.shippingDeducted && (
              <SettlementSection c={c} kind="SHIPPING_PAYMENT" id={id} label="送料の支払" />
            )}
            <SettlementSection
              c={c}
              kind="SALE_CREDIT_REFUND"
              id={id}
              label="金額訂正後の過入金返還"
              hideEmpty
            />
          </section>
        )}
        <div className="commerce-action-row">
          <Link className="button secondary" href={`/sales/orders/${id}/return?kind=REFUND`}>
            返金を記録
          </Link>
          <Link className="button secondary" href={`/sales/orders/${id}/return`}>
            返品を記録
          </Link>
          <Link className="button secondary" href={`/money/new?sale=${id}`}>
            再送料・追加費用
          </Link>
        </div>
        {activeUses.length > 0 && (
          <details className="commerce-disclosure">
            <summary>資材の使用</summary>
            {activeUses.map((u) => (
              <div className="commerce-charge-editor" key={u.id}>
                <div className="commerce-summary-line">
                  <span>
                    {u.supplyName}
                    <small className="commerce-secondary">
                      {u.purpose === "PACKING" ? "梱包用" : "商品構成用"} · {u.quantity.toString()}{" "}
                      · 単価 {u.unitCostJpy?.toString() ?? "未確認"}
                    </small>
                  </span>
                  <span>{money(u.costJpy)}</span>
                </div>
                {editable && (
                  <details className="commerce-disclosure">
                    <summary>使用量・単価を訂正</summary>
                    <MaterialUseEditor
                      supplies={supplies}
                      initial={{
                        context: c.context,
                        idempotencyKey: randomUUID(),
                        date: todayTokyo(),
                        saleId: id,
                        saleRevision: order.revision,
                        supplyItemId: u.supplyItemId,
                        purpose: u.purpose as "PACKING" | "COMPONENT",
                        quantity: u.quantity.toString(),
                        unitCost: u.unitCostJpy?.toString() ?? "",
                        sourceLineId: u.purchaseLineId,
                        manualPrice: true,
                        reason: "",
                        supersedesId: u.id,
                      }}
                    />
                  </details>
                )}
              </div>
            ))}
          </details>
        )}
        {editable && supplies.length > 0 && (
          <details className="commerce-disclosure">
            <summary>資材の追加使用</summary>
            <MaterialUseEditor
              key={order.revision}
              supplies={supplies}
              initial={{
                context: c.context,
                idempotencyKey: randomUUID(),
                date: todayTokyo(),
                saleId: id,
                saleRevision: order.revision,
                supplyItemId: supplies[0]!.id,
                purpose: "PACKING",
                quantity: "1",
                unitCost: supplies[0]!.unitCost,
                sourceLineId: supplies[0]!.sourceLineId,
                manualPrice: false,
                reason: "",
              }}
            />
          </details>
        )}
        <details className="commerce-disclosure">
          <summary>金額を補完・訂正</summary>
          <AmountAmendForm
            compact
            key={order.revision}
            context={c.context}
            orderId={order.id}
            revision={order.revision}
            today={todayTokyo()}
            initial={{
              actualPrice: order.grossSalesJpy.toString(),
              fee: order.feeJpy?.toString() ?? "",
              shipping: order.shippingJpy?.toString() ?? "",
              packing: order.packingJpy?.toString() ?? "",
              other: order.otherCostJpy?.toString() ?? "",
            }}
          />
        </details>
        {source.success && (
          <details className="commerce-disclosure">
            <summary>まとめ入力の元データ</summary>
            <p>元商品名：{source.data.sourceName}</p>
            {source.data.file && <p>元ファイル：{source.data.file}</p>}
            {source.data.purchasedAt && <p>元の購入日時：{source.data.purchasedAt}</p>}
            {source.data.updatedAt && <p>元の更新日時：{source.data.updatedAt}</p>}
            {source.data.amount !== undefined && (
              <p>
                元の商品代金：{source.data.amount}円／手数料：{source.data.fee}円／配送料：
                {source.data.shipping}円
              </p>
            )}
            {source.data.profit !== undefined && (
              <p>元の販売利益（商品原価控除前）：{source.data.profit}円</p>
            )}
            {source.data.url && (
              <p style={{ overflowWrap: "anywhere" }}>元の参照URL：{source.data.url}</p>
            )}
          </details>
        )}
        {(order.externalOrderId || order.buyerName || order.memo) && (
          <details className="commerce-disclosure">
            <summary>商品ID・購入者・メモ</summary>
            {order.externalOrderId && <p>商品ID {order.externalOrderId}</p>}
            {order.buyerName && <p>購入者 {order.buyerName}</p>}
            {order.memo && <p>{order.memo}</p>}
          </details>
        )}
        {order.returns.length > 0 && (
          <details className="commerce-disclosure">
            <summary>返品・返金の履歴 · {order.returns.length}件</summary>
            {order.returns.map((r) => (
              <div key={r.id}>
                <div className="commerce-summary-line">
                  <span>
                    {returnDates.get(r.id)?.replaceAll("-", "/")}
                    {editable &&
                      dateOperations.find(
                        (o) => o.sourceType === "sales_return" && o.sourceId === r.id,
                      ) && (
                        <>
                          {" "}
                          ·{" "}
                          <Link
                            href={`/inventory/events/${dateOperations.find((o) => o.sourceType === "sales_return" && o.sourceId === r.id)!.id}/date`}
                          >
                            日付を訂正
                          </Link>
                        </>
                      )}
                  </span>
                  <span>返金 {money(r.salesRefundJpy)}</span>
                </div>
                {editable && (
                  <>
                    <SettlementSection
                      c={c}
                      kind="SALE_REFUND"
                      id={r.id}
                      label="購入者への返金"
                      hideEmpty
                    />
                    <SettlementSection
                      c={c}
                      kind="SALE_FEE_REFUND"
                      id={r.id}
                      label="手数料の返還入金"
                      hideEmpty
                    />
                    <SettlementSection
                      c={c}
                      kind="SALE_SHIPPING_REFUND"
                      id={r.id}
                      label="送料の返還入金"
                      hideEmpty
                    />
                  </>
                )}
              </div>
            ))}
          </details>
        )}
        {editable && dateOperations.find((o) => o.sourceType === "sales_order") && (
          <details className="commerce-disclosure">
            <summary>記録の日付</summary>
            <div className="commerce-summary-line">
              <span>完了日 {completedDate}</span>
              <Link
                href={`/inventory/events/${dateOperations.find((o) => o.sourceType === "sales_order")!.id}/date`}
              >
                日付を訂正
              </Link>
            </div>
          </details>
        )}
        <div className="commerce-action-row">
          <ListBackLink
            context={salesListScope(c, c.fiscalYear.year)}
            className="commerce-text-button"
            href="/sales"
          >
            販売一覧へ
          </ListBackLink>
          <Link
            className="commerce-text-button"
            href={`/sales/new?channel=${order.salesChannelId}`}
          >
            続けて販売を記録
          </Link>
        </div>
      </div>
    </div>
  );
}
