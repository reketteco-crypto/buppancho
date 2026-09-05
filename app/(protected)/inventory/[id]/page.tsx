import Link from "next/link";
import { notFound } from "next/navigation";
import { requireInventoryContext } from "@/lib/inventory/context";
import { formatYen } from "@/lib/inventory/money";
import { updateInventoryItemAction } from "@/app/inventory/actions";

const movementLabel: Record<string, string> = {
  RECEIPT: "入庫",
  RECEIPT_REVERSAL: "仕入取消",
  LOCATION_TRANSFER: "場所移動",
  DISPOSAL: "廃棄",
  LOSS: "紛失",
  PERSONAL_USE: "私用",
  ADJUSTMENT_IN: "在庫増加",
  ADJUSTMENT_OUT: "在庫減少",
};

export default async function InventoryItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await requireInventoryContext();
  const item = await context.db.inventoryItem.findFirst({
    where: { id, workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
    include: {
      defaultStorageLocation: true,
      variants: {
        include: {
          costBalances: { where: { businessUnitId: context.businessUnitId } },
          inventoryLots: { include: { storageLocation: true }, orderBy: { receivedDate: "desc" } },
          uniqueStockUnits: {
            include: { storageLocation: true },
            orderBy: { individualCode: "asc" },
          },
          stockMovements: {
            include: { storageLocationFrom: true, storageLocationTo: true, operator: true },
            orderBy: { movementAt: "desc" },
            take: 100,
          },
        },
      },
    },
  });
  if (!item) notFound();
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
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">{item.itemCode}</p>
          <h1>{item.name}</h1>
          <p className="muted">
            既定: {item.managementType === "QUANTITY" ? "数量管理・移動平均法" : "個体管理・個別法"}
          </p>
        </div>
        <div className="status-actions">
          <Link className="button secondary" href="/inventory">
            一覧へ
          </Link>
          <Link className="button" href="/inventory/operations/new">
            在庫移動
          </Link>
        </div>
      </header>
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
          <form action={updateInventoryItemAction} className="stack" style={{ marginTop: 16 }}>
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
          </form>
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
                      <td>{lot.receivedDate.toISOString().slice(0, 10)}</td>
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
                .sort((a, b) => b.movementAt.getTime() - a.movementAt.getTime())
                .map((movement) => (
                  <tr key={movement.id}>
                    <td>
                      {movement.movementAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
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
