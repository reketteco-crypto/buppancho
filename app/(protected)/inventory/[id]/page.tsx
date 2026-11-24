import { MasterForm } from "@/components/forms/master-form";
import Link from "next/link";
import { ListBackLink } from "@/components/list-display-state";
import { notFound } from "next/navigation";
import { requireInventoryContext } from "@/lib/inventory/context";
import { formatYen } from "@/lib/inventory/money";
import { updateInventoryItemAction } from "@/app/inventory/actions";
import { effectiveCosts } from "@/lib/inventory/effective-cost";
import {
  effectiveLotReceiptDates,
  effectiveOperationTimeline,
  eventDay,
} from "@/lib/inventory/event-dates";

const movementLabel: Record<string, string> = {
  RECEIPT: "入庫",
  RECEIPT_REVERSAL: "仕入取消",
  LOCATION_TRANSFER: "場所移動",
  DISPOSAL: "廃棄",
  LOSS: "紛失",
  PERSONAL_USE: "私用",
  ADJUSTMENT_IN: "在庫増加",
  ADJUSTMENT_OUT: "在庫減少",
  SALE_OUT: "取引完了による出庫",
  RETURN_IN: "良品返品",
  RETURN_DEFECTIVE: "返品不良（販売不可）",
  RETURN_DISPOSAL: "返品廃棄",
};

export default async function InventoryItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recorded?: string }>;
}) {
  const { id } = await params;
  const recorded = (await searchParams).recorded === "1";
  const context = await requireInventoryContext();
  const item = await context.db.inventoryItem.findFirst({
    where: { id, workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
    include: {
      defaultStorageLocation: true,
      variants: {
        include: {
          inventoryReservations: { where: { status: "RESERVED" }, include: { listing: true } },
          costBalances: { where: { businessUnitId: context.businessUnitId } },
          inventoryLots: { include: { storageLocation: true }, orderBy: { receivedDate: "desc" } },
          uniqueStockUnits: {
            include: { storageLocation: true },
            orderBy: { individualCode: "asc" },
          },
          stockMovements: {
            include: {
              storageLocationFrom: true,
              storageLocationTo: true,
              operator: true,
              operation: true,
            },
            orderBy: { movementAt: "desc" },
          },
        },
      },
    },
  });
  if (!item) notFound();
  const observations = await context.db.stocktakeObservation.findMany({
    where: {
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      itemVariantId: { in: item.variants.map((v) => v.id) },
    },
    orderBy: { createdAt: "desc" },
  });
  const countOperations = await context.db.inventoryOperation.findMany({
    where: {
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      id: { in: observations.map((s) => s.operationId) },
    },
  });
  const countDates = await effectiveOperationTimeline(context.db, countOperations);
  const [eventTimeline, receiptDates] = await Promise.all([
    effectiveOperationTimeline(
      context.db,
      item.variants.flatMap((v) => v.stockMovements.map((m) => m.operation)),
    ),
    effectiveLotReceiptDates(
      context.db,
      item.variants.flatMap((v) => v.inventoryLots.map((l) => l.id)),
    ),
  ]);
  const defective = await context.db.stockMovement.findMany({
    where: {
      itemVariant: { inventoryItemId: item.id },
      businessUnitId: context.businessUnitId,
      movementType: "RETURN_DEFECTIVE",
    },
  });
  const defectiveCost = await effectiveCosts(context.db, "MOVEMENT", defective);
  const defectiveQuantity = defective.reduce((s, m) => s + m.quantity, 0);
  const held = item.variants
    .flatMap((v) => v.inventoryReservations)
    .reduce((s, r) => s + r.quantity, 0);
  const quantity = item.variants.reduce(
    (sum, variant) =>
      sum + variant.costBalances.reduce((subtotal, balance) => subtotal + balance.quantity, 0),
    0,
  );
  const cost = item.variants.reduce(
    (sum, variant) =>
      sum +
      variant.costBalances.reduce(
        (subtotal, balance) => subtotal + balance.carryingCostTotalJpy,
        0n,
      ),
    0n,
  );
  const locations = await context.db.storageLocation.findMany({
    where: {
      workspaceId: context.workspaceId,
      active: true,
      OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
    },
    orderBy: { code: "asc" },
  });
  const salesSkus = await context.db.salesSku.findMany({
    where: {
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      components: {
        some: {
          OR: [
            { itemVariant: { inventoryItemId: item.id } },
            { uniqueStockUnit: { itemVariant: { inventoryItemId: item.id } } },
          ],
        },
      },
    },
    include: { listings: true, orderLines: { include: { salesOrder: true } } },
    orderBy: { createdAt: "desc" },
  });
  return (
    <div className="page">
      <section className="card">
        <p>
          出品に使える：{Math.max(0, quantity - held)} ／ 出品・注文用に確保：{held} ／
          管理上の残数：{quantity}
        </p>
        <p className="muted">
          管理残数は実際に手元にある数とは限りません。確保中には発送済み商品を含む場合があります。
        </p>
        {item.variants
          .flatMap((v) => v.inventoryReservations)
          .filter((r) => r.listingId)
          .map((r) => (
            <p key={r.id}>
              <Link href={`/sales/listings/${r.listingId}`}>
                確保中の出品 {r.listing?.externalListingId}・{r.quantity}個
              </Link>
            </p>
          ))}
      </section>
      {!!defectiveQuantity && (
        <section className="card">
          <h2>販売不可の返品在庫</h2>
          <p>
            不良品：{defectiveQuantity}個 ／ 訂正反映後原価 ¥
            {formatYen([...defectiveCost.values()].reduce((s, v) => s + v, 0n))}
          </p>
          <p className="muted">
            上の出品可能数・販売用原価には含めません。廃棄済みの返品とは別に記録しています。
          </p>
        </section>
      )}
      <header className="page-header">
        <div>
          <p className="eyebrow">{item.itemCode}</p>
          <h1>{item.name}</h1>
          <p className="muted">
            既定: {item.managementType === "QUANTITY" ? "数量管理・移動平均法" : "個体管理・個別法"}
          </p>
        </div>
        <div className="status-actions">
          <Link className="button" href={`/sales/listings/new?item=${item.id}`}>
            この商品を出品する
          </Link>
          <ListBackLink
            context={`${context.workspaceId}:${context.operatorId}:${context.businessUnitId}:${context.fiscalYear.year}`}
            className="button secondary"
            href="/inventory"
          >
            一覧へ
          </ListBackLink>
          <Link className="button" href="/inventory/operations/new">
            在庫移動
          </Link>
          <Link className="button secondary" href={`/inventory/stocktake/new?item=${item.id}`}>
            数えた数量を訂正
          </Link>
        </div>
      </header>
      {recorded && (
        <p role="status" className="message success">
          在庫操作を記録しました。在庫数・保管場所と履歴をご確認ください。
        </p>
      )}
      {observations.length > 0 && (
        <section className="card form-stack">
          <h2>実測数量の確認・訂正履歴</h2>
          {observations.map((s) => (
            <article key={s.id}>
              <p>
                {countDates.get(s.operationId)?.date}：帳簿 {s.bookQuantity}個 → 実測{" "}
                {s.countedQuantity}個（差 {s.difference > 0 ? "+" : ""}
                {s.difference}個）
              </p>
              <Link href={`/inventory/events/${s.operationId}/date`}>
                記録日と訂正履歴を確認する
              </Link>
            </article>
          ))}
        </section>
      )}
      <div className="metric-grid">
        <div className="card metric">
          <span>現在庫</span>
          <strong>{quantity}点</strong>
        </div>
        <div className="card metric">
          <span>管理原価総額</span>
          <strong>¥{formatYen(cost)}</strong>
        </div>
        <div className="card metric">
          <span>既定保管場所</span>
          <strong>{item.defaultStorageLocation?.name ?? "未設定"}</strong>
        </div>
      </div>
      <section className="card section-block">
        <h2>基本情報</h2>
        <dl className="detail-grid">
          <div>
            <dt>カテゴリ</dt>
            <dd>{item.category ?? "未設定"}</dd>
          </div>
          <div>
            <dt>状態</dt>
            <dd>{item.status === "ACTIVE" ? "有効" : "無効"}</dd>
          </div>
          <div>
            <dt>メモ</dt>
            <dd>{item.memo ?? "なし"}</dd>
          </div>
        </dl>
        <details style={{ marginTop: 18 }}>
          <summary>基本情報を編集</summary>
          <MasterForm
            action={updateInventoryItemAction}
            className="stack"
            style={{ marginTop: 16 }}
          >
            <input type="hidden" name="revision" value={item.revision} />
            <input type="hidden" name="id" value={item.id} />
            <div className="form-grid">
              <div className="field">
                <span>商品コード</span>
                <strong>{item.itemCode}</strong>
                <small className="muted">商品コードは登録後に変更できません。</small>
              </div>
              <label className="field">
                <span>商品名</span>
                <input name="name" defaultValue={item.name} required />
              </label>
              <label className="field">
                <span>カテゴリ</span>
                <input name="category" defaultValue={item.category ?? ""} />
              </label>
              <label className="field">
                <span>既定の商品区分</span>
                <select
                  name="defaultConditionCategory"
                  defaultValue={item.defaultConditionCategory}
                >
                  <option value="UNSPECIFIED">未指定</option>
                  <option value="NEW">新品</option>
                  <option value="USED">中古</option>
                </select>
              </label>
              <label className="field">
                <span>既定保管場所</span>
                <select
                  name="defaultStorageLocationId"
                  defaultValue={item.defaultStorageLocationId ?? ""}
                >
                  <option value="">未設定</option>
                  {locations.map((location) => (
                    <option value={location.id} key={location.id}>
                      {location.code} {location.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>メモ</span>
              <textarea name="memo" defaultValue={item.memo ?? ""} />
            </label>
            <label className="check">
              <input type="checkbox" name="active" defaultChecked={item.status === "ACTIVE"} />
              有効
            </label>
            <button className="button">基本情報を保存</button>
          </MasterForm>
        </details>
      </section>
      <section className="card section-block">
        <h2>バリアント別 在庫・原価内訳</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>バリアントコード</th>
                <th>属性</th>
                <th>追跡方式</th>
                <th>在庫</th>
                <th>管理原価</th>
                <th>平均／個別原価</th>
              </tr>
            </thead>
            <tbody>
              {item.variants.flatMap((variant) =>
                variant.costBalances.map((balance) => (
                  <tr key={balance.id}>
                    <td>{variant.variantCode}</td>
                    <td>
                      {Object.entries(variant.attributesJson as Record<string, string>)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(" / ") || "標準"}
                    </td>
                    <td>{balance.trackingMode === "QUANTITY" ? "数量管理" : "個体管理"}</td>
                    <td>{balance.quantity}</td>
                    <td>¥{formatYen(balance.carryingCostTotalJpy)}</td>
                    <td>
                      ¥
                      {balance.trackingMode === "QUANTITY"
                        ? balance.averageUnitCostJpy.toFixed(0)
                        : formatYen(
                            balance.quantity
                              ? balance.carryingCostTotalJpy / BigInt(balance.quantity)
                              : 0n,
                          )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </section>
      {item.variants.some((variant) => variant.uniqueStockUnits.length > 0) ? (
        <section className="card section-block">
          <h2>個体在庫</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>個体コード</th>
                  <th>状態説明</th>
                  <th>在庫状態</th>
                  <th>保管場所</th>
                  <th>個別原価</th>
                </tr>
              </thead>
              <tbody>
                {item.variants
                  .flatMap((variant) => variant.uniqueStockUnits)
                  .map((unit) => (
                    <tr key={unit.id}>
                      <td>{unit.individualCode}</td>
                      <td>{unit.condition}</td>
                      <td>{unit.status}</td>
                      <td>{unit.storageLocation.name}</td>
                      <td>¥{formatYen(unit.acquisitionCostJpy)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {item.variants.some((variant) => variant.inventoryLots.length > 0) ? (
        <section className="card section-block">
          <h2>在庫・ロット</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>入庫日</th>
                  <th>入庫数</th>
                  <th>残数</th>
                  <th>取得原価</th>
                  <th>入庫場所</th>
                </tr>
              </thead>
              <tbody>
                {item.variants
                  .flatMap((variant) => variant.inventoryLots)
                  .map((lot) => (
                    <tr key={lot.id}>
                      <td>
                        {receiptDates.get(lot.id) ?? lot.receivedDate.toISOString().slice(0, 10)}
                      </td>
                      <td>{lot.receivedQuantity}</td>
                      <td>{lot.remainingQuantity}</td>
                      <td>¥{formatYen(lot.landedCostTotalJpy)}</td>
                      <td>{lot.storageLocation.name}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <section className="card section-block">
        <div className="section-heading">
          <div>
            <h2>出品・完了履歴</h2>
            <p className="muted">セットの構成品として使った記録も表示します。</p>
          </div>
          <Link className="button secondary" href={`/sales/listings/new?item=${item.id}`}>
            この商品を出品する
          </Link>
        </div>
        <ul className="activity-list">
          {salesSkus.flatMap((sku) =>
            sku.listings.map((listing) => (
              <li key={listing.id}>
                <Link href={`/sales/listings/${listing.id}`}>
                  <strong>{listing.displayName ?? sku.name}</strong>
                  <span>
                    出品 ¥{formatYen(listing.currentPriceJpy)}・
                    {listing.externalListingId ?? "商品ID未確認"}
                  </span>
                </Link>
              </li>
            )),
          )}
          {salesSkus.flatMap((sku) =>
            sku.orderLines
              .filter((line) => line.salesOrder.completedAt)
              .map((line) => (
                <li key={line.id}>
                  <Link href={`/sales/orders/${line.salesOrderId}`}>
                    <strong>{line.displayName ?? sku.name}</strong>
                    <span>完了実績 ¥{formatYen(line.salesOrder.grossSalesJpy)}</span>
                  </Link>
                </li>
              )),
          )}
        </ul>
        {!salesSkus.some(
          (sku) =>
            sku.listings.length || sku.orderLines.some((line) => line.salesOrder.completedAt),
        ) && <p className="empty-state">出品・完了の記録はまだありません。</p>}
      </section>
      <section className="card section-block">
        <h2>在庫移動</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>日時</th>
                <th>操作</th>
                <th>数量</th>
                <th>移動元 → 移動先</th>
                <th>入力者</th>
                <th>メモ</th>
              </tr>
            </thead>
            <tbody>
              {item.variants
                .flatMap((variant) => variant.stockMovements)
                .sort(
                  (a, b) =>
                    eventTimeline
                      .get(b.operationId)!
                      .date.localeCompare(eventTimeline.get(a.operationId)!.date) ||
                    b.movementAt.getTime() - a.movementAt.getTime(),
                )
                .slice(0, 100)
                .map((movement) => (
                  <tr key={movement.id}>
                    <td>
                      <p>{eventTimeline.get(movement.operationId)!.date}</p>
                      {eventTimeline.get(movement.operationId)!.date !==
                        eventDay(movement.movementAt) && (
                        <small>当初：{eventDay(movement.movementAt)}</small>
                      )}
                      <p>
                        <Link href={`/inventory/events/${movement.operationId}/date`}>
                          日付を訂正
                        </Link>
                      </p>
                    </td>
                    <td>{movementLabel[movement.movementType] ?? movement.movementType}</td>
                    <td>{movement.quantity}</td>
                    <td>
                      {movement.storageLocationFrom?.name ?? "—"} →{" "}
                      {movement.storageLocationTo?.name ?? "—"}
                    </td>
                    <td>{movement.operator.displayName}</td>
                    <td>{movement.note ?? ""}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
