import { InputReturnLink } from "@/components/input-return-link";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { Precise } from "@/lib/commerce/allocation";
import { ReceiptEditor } from "./receipt-form";
import { ListBackLink } from "@/components/list-display-state";
import { SupplierReturnEditor } from "./purchase-return-form";
import { PurchaseCancelEditor } from "./purchase-cancel-form";
import { PurchaseCosts } from "./cost-section";
import { SettlementSection } from "./settlement-section";
import { effectiveOperationDates } from "@/lib/inventory/event-dates";
import { transactionScope } from "@/lib/commerce/scope";
import { notFound } from "next/navigation";

export async function GenericPurchaseDetail({ id, returnTo }: { id: string; returnTo?: string }) {
  const c = await commerceContext();
  const p = await c.db.purchaseDocument.findFirst({
    where: { id, ...transactionScope(c) },
    include: {
      lines: {
        orderBy: { position: "asc" },
        include: {
          receipts: { include: { receipt: true, inventoryLot: true, supplierReturns: true } },
          deliveries: { include: { delivery: true, receipts: true, receiptLinks: true } },
        },
      },
      charges: {
        orderBy: { createdAt: "asc" },
        include: { allocations: true, supersededBy: true },
      },
    },
  });
  if (!p) notFound();
  const locations = await c.db.storageLocation.findMany({
    where: {
      workspaceId: c.workspaceId,
      active: true,
      OR: [{ businessUnitId: null }, { businessUnitId: c.businessUnitId }],
    },
  });
  const editable = p.status !== "CANCELLED" && p.reportingEntityId === c.reportingEntityId;
  const currency = (v: bigint) => `¥${v.toLocaleString("ja-JP")}`;
  const remaining = p.lines.filter((l) => l.receivedQuantity < l.quantity);
  const receipts = [
    ...new Map(
      p.lines.flatMap((l) => l.receipts.map((r) => [r.receipt.id, r.receipt] as const)),
    ).values(),
  ];
  const operations = await c.db.inventoryOperation.findMany({
    where: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      OR: [
        { id: { in: receipts.flatMap((r) => (r.operationId ? [r.operationId] : [])) } },
        {
          id: {
            in: p.lines.flatMap((l) =>
              l.receipts.flatMap((r) => r.supplierReturns.map((v) => v.operationId)),
            ),
          },
        },
        { sourceType: "purchase_document", sourceId: p.id },
      ],
    },
  });
  const operationDates = await effectiveOperationDates(c.db, operations);
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <div>
          <p className="commerce-overline">{p.code}</p>
          <h1>{p.supplierName}</h1>
        </div>
        <span className={`commerce-badge${remaining.length ? " pending" : ""}`}>
          {p.status === "CANCELLED" ? "取消済み" : remaining.length ? "受取待ち" : "受取済み"}
        </span>
      </header>
      <InputReturnLink returnTo={returnTo} />
      <div className="commerce-editor">
        <p className="commerce-secondary">購入日 {p.purchasedDate.toISOString().slice(0, 10)}</p>
        {p.currency !== "JPY" && (
          <p className="commerce-secondary">
            {p.currency} · 1 {p.currency} = ¥{p.exchangeRate?.toString()}
            {p.actualOrderJpy !== null ? ` · 円建て実額 ${currency(p.actualOrderJpy)}` : ""}
          </p>
        )}
        <div className="commerce-list">
          {p.lines.map((l) => (
            <div className="commerce-row" key={l.id}>
              <div>
                <strong>{l.name}</strong>
                {l.sourceName && l.sourceName !== l.name && (
                  <small className="commerce-secondary">取込名 {l.sourceName}</small>
                )}
                <span className="commerce-secondary">
                  {l.quantity} 点 · 受取済み {l.receivedQuantity} 点
                </span>
              </div>
              <span className="commerce-number">
                {currency(l.landedCostJpy)}
                <small>
                  {l.receivedQuantity > 0 && l.receivedQuantity < l.quantity ? "注文平均 " : ""}1点
                  ¥
                  {new Precise(l.landedCostJpy.toString())
                    .div(l.quantity)
                    .toDecimalPlaces(2)
                    .toFixed(2)}
                </small>
              </span>
            </div>
          ))}
        </div>
        <div className="commerce-summary-line">
          <strong>購入合計</strong>
          <strong>{currency(p.totalJpy)}</strong>
        </div>
        {!p.costFinal && <p className="commerce-caption">原価は暫定です。</p>}
        {editable && (
          <>
            <SettlementSection c={c} kind="PURCHASE_PAYMENT" id={p.id} />
            <SettlementSection
              c={c}
              kind="PURCHASE_CREDIT_REFUND"
              id={p.id}
              label="金額訂正後の過払い返金"
              hideEmpty
            />
          </>
        )}
        {p.lines
          .flatMap((l) => l.receipts.flatMap((r) => r.supplierReturns))
          .map((r) => (
            <details key={r.id} className="commerce-disclosure">
              <summary>取引先へ返送 {r.quantity}点</summary>
              <p className="commerce-secondary">
                {operationDates.get(r.operationId) ?? r.returnedDate.toISOString().slice(0, 10)} ·{" "}
                {r.reason}
              </p>
              {editable && <SettlementSection c={c} kind="SUPPLIER_RETURN_REFUND" id={r.id} />}
            </details>
          ))}
        {remaining.length > 0 && editable && (
          <details className="commerce-disclosure">
            <summary>受取を記録</summary>
            <ReceiptEditor
              key={`receipt:${p.revision}`}
              initial={{
                context: c.context,
                idempotencyKey: randomUUID(),
                date: todayTokyo(),
                purchaseId: p.id,
                revision: p.revision,
                locationId: locations[0]?.id ?? "",
                lines: remaining.map((l) => ({
                  lineId: l.id,
                  quantity: Math.min(
                    l.quantity - l.receivedQuantity,
                    ...l.deliveries
                      .filter(
                        (d) =>
                          d.quantity >
                          d.receipts.reduce((s, r) => s + r.quantity, 0) +
                            d.receiptLinks.reduce((s, r) => s + r.quantity, 0),
                      )
                      .map(
                        (d) =>
                          d.quantity -
                          d.receipts.reduce((s, r) => s + r.quantity, 0) -
                          d.receiptLinks.reduce((s, r) => s + r.quantity, 0),
                      ),
                  ),
                  ...(l.deliveries.filter(
                    (d) =>
                      d.quantity >
                      d.receipts.reduce((s, r) => s + r.quantity, 0) +
                        d.receiptLinks.reduce((s, r) => s + r.quantity, 0),
                  ).length === 1
                    ? {
                        deliveryLineId: l.deliveries.find(
                          (d) =>
                            d.quantity >
                            d.receipts.reduce((s, r) => s + r.quantity, 0) +
                              d.receiptLinks.reduce((s, r) => s + r.quantity, 0),
                        )!.id,
                      }
                    : {}),
                })),
              }}
              lines={remaining.map((l) => ({
                id: l.id,
                name: l.name,
                remaining: l.quantity - l.receivedQuantity,
                deliveries: l.deliveries
                  .map((d) => ({
                    id: d.id,
                    name: `${d.delivery.code} ${d.delivery.methodName || "配送"}`,
                    remaining:
                      d.quantity -
                      d.receipts.reduce((s, r) => s + r.quantity, 0) -
                      d.receiptLinks.reduce((s, r) => s + r.quantity, 0),
                  }))
                  .filter((d) => d.remaining > 0),
              }))}
              locations={locations.map((l) => ({ id: l.id, name: l.name }))}
            />
          </details>
        )}
        <section className="commerce-section">
          <div className="commerce-section-heading">
            <h2>配送・費用</h2>
            {editable && (
              <div className="commerce-import-actions">
                <Link
                  className="commerce-text-button"
                  href={`/purchases/deliveries/new?purchase=${p.id}&import=1`}
                >
                  配送明細を取り込む
                </Link>
                <Link
                  className="commerce-text-button"
                  href={`/purchases/deliveries/new?purchase=${p.id}`}
                >
                  配送を追加
                </Link>
              </div>
            )}
          </div>
          {[
            ...new Map(
              p.lines.flatMap((l) => l.deliveries.map((d) => [d.deliveryId, d.delivery] as const)),
            ).values(),
          ].map((d) => (
            <Link key={d.id} className="commerce-row" href={`/purchases/deliveries/${d.id}`}>
              <span>
                {d.code} · {d.methodName || "配送"}
              </span>
              <span>{d.shippedDate.toISOString().slice(0, 10)}</span>
            </Link>
          ))}
          <PurchaseCosts
            c={c}
            readOnly={!editable}
            source={{ purchaseId: p.id, revision: p.revision }}
            lines={p.lines.map((l) => ({
              id: l.id,
              name: l.name,
              itemVariantId: l.itemVariantId,
              weight: l.weightG?.toString() ?? "",
              volume: l.volumeCm3?.toString() ?? "",
            }))}
            charges={p.charges}
          />
        </section>
        {editable &&
          p.lines.some((l) =>
            l.receipts.some((r) => (r.inventoryLot?.remainingQuantity || 0) > 0),
          ) && (
            <details className="commerce-disclosure">
              <summary>取引先への現物返送</summary>
              <SupplierReturnEditor
                initial={{
                  context: c.context,
                  idempotencyKey: randomUUID(),
                  date: todayTokyo(),
                  revision: p.revision,
                  receiptLineId: p.lines
                    .flatMap((l) => l.receipts)
                    .find((r) => (r.inventoryLot?.remainingQuantity || 0) > 0)!.id,
                  quantity: 1,
                  refund: "",
                  reason: "",
                }}
                receipts={p.lines
                  .flatMap((l) =>
                    l.receipts.map((r) => ({
                      id: r.id,
                      name: `${l.name} ${r.receipt.receivedDate.toISOString().slice(0, 10)}`,
                      quantity: Math.min(
                        r.quantity - r.supplierReturns.reduce((s, v) => s + v.quantity, 0),
                        r.inventoryLot?.remainingQuantity || 0,
                      ),
                    })),
                  )
                  .filter((r) => r.quantity > 0)}
              />
            </details>
          )}
        <details className="commerce-disclosure">
          <summary>原価の内訳</summary>
          {p.lines.map((l) => (
            <div key={l.id} className="commerce-summary-line">
              <span>{l.name}</span>
              <span>
                商品代 {currency(l.productAmountJpy)}
                <small className="commerce-secondary">
                  費用配分 {currency(l.landedCostJpy - l.productAmountJpy)}
                </small>
              </span>
            </div>
          ))}
        </details>
        <details className="commerce-disclosure">
          <summary>記録の履歴</summary>
          <div className="commerce-summary-line">
            <span>購入を記録</span>
            <span>{p.purchasedDate.toISOString().slice(0, 10)}</span>
          </div>
          {receipts.map((r) => (
            <div className="commerce-summary-line" key={r.id}>
              <span>受取を記録</span>
              <span>
                {(r.operationId && operationDates.get(r.operationId)) ||
                  r.receivedDate.toISOString().slice(0, 10)}
                {editable && r.operationId && (
                  <>
                    {" "}
                    · <Link href={`/inventory/events/${r.operationId}/date`}>日付を訂正</Link>
                  </>
                )}
              </span>
            </div>
          ))}
          {operations
            .filter((o) => o.sourceType === "purchase_document")
            .map((o) => (
              <div className="commerce-summary-line" key={o.id}>
                <span>購入を取消</span>
                <span>{operationDates.get(o.id)}</span>
              </div>
            ))}
        </details>
        {p.memo && (
          <details className="commerce-disclosure">
            <summary>メモ</summary>
            <p>{p.memo}</p>
          </details>
        )}
        {editable && (
          <details className="commerce-disclosure">
            <summary>誤って登録した購入を取り消す</summary>
            <PurchaseCancelEditor
              initial={{
                context: c.context,
                idempotencyKey: randomUUID(),
                date: todayTokyo(),
                valuationPosition: "LAST",
                purchaseId: p.id,
                revision: p.revision,
                reason: "",
              }}
            />
          </details>
        )}
        <div className="commerce-action-row">
          <Link href="/products" className="button secondary">
            商品を確認
          </Link>
          <Link href={`/purchases/new?repeat=${p.id}`} className="commerce-text-button">
            続けて購入を記録
          </Link>
          <ListBackLink
            context={`${c.businessUnitId}:${c.fiscalYear.year}`}
            href="/purchases"
            className="commerce-text-button"
          >
            購入一覧へ
          </ListBackLink>
        </div>
      </div>
    </div>
  );
}
