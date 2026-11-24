import Link from "next/link";
import { GenericPurchaseDetail } from "@/components/commerce/purchase-detail";
import { ListBackLink } from "@/components/list-display-state";
import { notFound } from "next/navigation";
import { loadPurchaseReview } from "@/lib/inventory/purchase-conflict";
import type { PurchaseBaseline } from "@/lib/inventory/purchase-comparison";
import { PurchaseEventForm } from "@/components/forms/purchase-event-form";
import { inputContext, recoveryRequest } from "@/lib/sales/workflow-view";
import { requireInventoryContext } from "@/lib/inventory/context";
import { formatYen } from "@/lib/inventory/money";
import { effectiveOperationDates } from "@/lib/inventory/event-dates";
import { operationLabels } from "@/lib/inventory/operation-labels";
import { transactionScope } from "@/lib/commerce/scope";

export default async function PurchaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    operation?: string;
    operationKind?: string;
    recorded?: string;
    returnTo?: string;
  }>;
}) {
  const { id } = await params;
  const context = await requireInventoryContext();
  if (
    await context.db.purchaseDocument.findFirst({
      where: { id, ...transactionScope(context) },
      select: { id: true },
    })
  )
    return <GenericPurchaseDetail id={id} returnTo={(await searchParams).returnTo} />;
  const purchase = await context.db.purchase.findFirst({
    where: { id, ...transactionScope(context) },
    include: {
      supplier: true,
      storageLocation: true,
      reportingEntity: true,
      lines: { include: { itemVariant: { include: { inventoryItem: true } }, inventoryLot: true } },
    },
  });
  if (!purchase) notFound();
  const stockEvents = await context.db.inventoryOperation.findMany({
    where: {
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      sourceType: "purchase",
      sourceId: purchase.id,
      operationType: { in: ["PURCHASE_RECEIPT", "PURCHASE_REVERSAL"] },
    },
    orderBy: { occurredAt: "asc" },
  });
  const stockDates = await effectiveOperationDates(context.db, stockEvents);
  const review = await loadPurchaseReview(
    context.db,
    { ...context, year: context.fiscalYear.year, userAccountId: context.session.userAccountId },
    { purchaseId: id },
  );
  const query = await searchParams;
  const operationKind =
    query.operationKind === "PURCHASE_RECEIVE" ? "PURCHASE_RECEIVE" : "PURCHASE_CANCEL";
  const recovery = await recoveryRequest(context, query.operation, operationKind);
  const recoveryPayload = recovery?.payload as
    | {
        purchaseId?: string;
        date?: string;
        reason?: string;
        revision?: number;
        baseSnapshot?: PurchaseBaseline | null;
      }
    | undefined;
  const initial = recoveryPayload?.purchaseId === purchase.id ? recoveryPayload : undefined;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const allocated = purchase.lines.reduce((sum, line) => sum + line.finalLandedCostJpy, 0n);
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">{purchase.purchaseCode}</p>
          <h1>仕入れ</h1>
          <p className="muted">
            {purchase.status === "DRAFT"
              ? "内容を確認して入庫を確定してください。"
              : "確定済みの内容は直接編集できません。"}
          </p>
        </div>
        <ListBackLink
          context={`${context.workspaceId}:${context.operatorId}:${context.businessUnitId}:${context.fiscalYear.year}`}
          className="button secondary"
          href="/purchases"
        >
          仕入一覧へ
        </ListBackLink>
      </header>
      {query.recorded === "1" && (
        <p role="status" className="message success">
          仕入れの記録を保存しました。状態・在庫と履歴をご確認ください。
        </p>
      )}
      <div className="metric-grid">
        <div className="card metric">
          <span>仕入総額</span>
          <strong>¥{formatYen(purchase.purchaseTotalJpy)}</strong>
        </div>
        <div className="card metric">
          <span>明細合計</span>
          <strong>¥{formatYen(allocated)}</strong>
        </div>
        <div className="card metric">
          <span>状態</span>
          <strong>
            {purchase.status === "DRAFT"
              ? "下書き"
              : purchase.status === "FINALIZED"
                ? "確定"
                : "取消"}
          </strong>
        </div>
      </div>
      <section className="card section-block">
        <h2>仕入情報</h2>
        {stockEvents.map((e) => (
          <p key={e.id}>
            {operationLabels[e.operationType]}日：{stockDates.get(e.id)}{" "}
            <Link href={`/inventory/events/${e.id}/date`}>日付を訂正</Link>
          </p>
        ))}
        <dl className="detail-grid">
          <div>
            <dt>仕入日</dt>
            <dd>{purchase.purchasedDate.toISOString().slice(0, 10)}</dd>
          </div>
          <div>
            <dt>仕入先</dt>
            <dd>{purchase.supplier.name}</dd>
          </div>
          <div>
            <dt>保管場所</dt>
            <dd>{purchase.storageLocation.name}</dd>
          </div>
          <div>
            <dt>申告主体</dt>
            <dd>{purchase.reportingEntity.displayName}</dd>
          </div>
          <div>
            <dt>注文番号</dt>
            <dd>{purchase.orderNumber ?? "なし"}</dd>
          </div>
          <div>
            <dt>メモ</dt>
            <dd>{purchase.memo ?? "なし"}</dd>
          </div>
        </dl>
      </section>
      <section className="card section-block">
        <h2>明細</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th>商品区分</th>
                <th>追跡方式</th>
                <th>数量／個体コード</th>
                <th>状態</th>
                <th>原価</th>
                <th>入庫</th>
              </tr>
            </thead>
            <tbody>
              {purchase.lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <Link href={`/inventory/${line.itemVariant.inventoryItem.id}`}>
                      {line.itemVariant.inventoryItem.name}
                    </Link>
                    <br />
                    <small>{line.sourceName}</small>
                  </td>
                  <td>
                    {line.conditionCategory === "NEW"
                      ? "新品"
                      : line.conditionCategory === "USED"
                        ? "中古"
                        : "未指定"}
                  </td>
                  <td>{line.trackingMode === "QUANTITY" ? "数量管理" : "個体管理"}</td>
                  <td>
                    {line.trackingMode === "QUANTITY"
                      ? line.orderedQuantity
                      : line.draftIndividualCode || "確定時に自動採番"}
                  </td>
                  <td>{line.draftCondition || "—"}</td>
                  <td>¥{formatYen(line.finalLandedCostJpy)}</td>
                  <td>{line.inventoryLot ? "済" : "未"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {purchase.status === "DRAFT" ? (
        <section className="card action-panel purchase-action-panel">
          <div>
            <h2>仕入確定・入庫</h2>
            <p className="muted">
              確定後は直接編集できません。全明細を1つのトランザクションで入庫します。
            </p>
          </div>
          <div className="purchase-status-actions">
            <Link className="button secondary" href={`/purchases/${purchase.id}/edit`}>
              下書きを編集
            </Link>
            <PurchaseEventForm
              review={review}
              kind="PURCHASE_RECEIVE"
              context={inputContext(context)}
              purchaseId={purchase.id}
              revision={purchase.revision}
              today={today}
              initial={operationKind === "PURCHASE_RECEIVE" ? initial : undefined}
            />
            <details>
              <summary>この仕入れを取り消す（在庫変更なし）</summary>
              <PurchaseEventForm
                review={review}
                kind="PURCHASE_CANCEL"
                context={inputContext(context)}
                purchaseId={purchase.id}
                revision={purchase.revision}
                today={today}
                initial={operationKind === "PURCHASE_CANCEL" ? initial : undefined}
              />
            </details>
          </div>
        </section>
      ) : null}
      {recovery &&
        purchase.status !== "DRAFT" &&
        (operationKind === "PURCHASE_RECEIVE" || purchase.status === "CANCELLED") && (
          <section className="card">
            <h2>保存要求の結果確認</h2>
            <PurchaseEventForm
              review={review}
              kind={operationKind}
              context={inputContext(context)}
              purchaseId={purchase.id}
              revision={purchase.revision}
              today={today}
              initial={initial}
            />
          </section>
        )}
      {purchase.status === "FINALIZED" ? (
        <section className="card action-panel purchase-action-panel">
          <div>
            <h2>確定仕入れの取消</h2>
            <p className="muted">
              入庫後の移動がなく、全量残っている場合だけ反対移動で取り消せます。
            </p>
          </div>
          <PurchaseEventForm
            review={review}
            kind="PURCHASE_CANCEL"
            context={inputContext(context)}
            purchaseId={purchase.id}
            revision={purchase.revision}
            today={today}
            initial={operationKind === "PURCHASE_CANCEL" ? initial : undefined}
          />
        </section>
      ) : null}
    </div>
  );
}
