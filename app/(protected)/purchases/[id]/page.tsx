import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteDraftPurchaseAction, finalizePurchaseAction } from "@/app/inventory/actions";
import { PurchaseCancelForm } from "@/components/forms/purchase-cancel-form";
import { requireInventoryContext } from "@/lib/inventory/context";
import { formatYen } from "@/lib/inventory/money";

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireInventoryContext();
  const purchase = await context.db.purchase.findFirst({
    where: { id, workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
    include: {
      supplier: true,
      storageLocation: true,
      reportingEntity: true,
      lines: { include: { itemVariant: { include: { inventoryItem: true } }, inventoryLot: true } },
    },
  });
  if (!purchase) notFound();
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
        <Link className="button secondary" href="/purchases">
          仕入一覧へ
        </Link>
      </header>
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
        <section className="card action-panel">
          <div>
            <h2>仕入確定・入庫</h2>
            <p className="muted">
              確定後は直接編集できません。全明細を1つのトランザクションで入庫します。
            </p>
          </div>
          <div className="status-actions">
            <Link className="button secondary" href={`/purchases/${purchase.id}/edit`}>
              下書きを編集
            </Link>
            <form action={deleteDraftPurchaseAction}>
              <input type="hidden" name="id" value={purchase.id} />
              <button className="button danger">下書きを削除</button>
            </form>
            <form action={finalizePurchaseAction}>
              <input type="hidden" name="id" value={purchase.id} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <button className="button">仕入確定・入庫</button>
            </form>
          </div>
        </section>
      ) : null}
      {purchase.status === "FINALIZED" ? (
        <section className="card action-panel">
          <div>
            <h2>確定仕入れの取消</h2>
            <p className="muted">
              入庫後の移動がなく、全量残っている場合だけ反対移動で取り消せます。
            </p>
          </div>
          <PurchaseCancelForm purchaseId={purchase.id} />
        </section>
      ) : null}
    </div>
  );
}
