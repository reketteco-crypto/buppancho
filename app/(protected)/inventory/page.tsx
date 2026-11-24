import Link from "next/link";
import { ListDisplayState } from "@/components/list-display-state";
import { Prisma } from "@/generated/prisma/client";
import { requireInventoryContext } from "@/lib/inventory/context";
import { formatYen } from "@/lib/inventory/money";

const PAGE_SIZE = 50;
type SearchParams = Record<string, string | string[] | undefined>;

function stringParam(params: SearchParams, key: string): string {
  return typeof params[key] === "string" ? params[key].trim() : "";
}

function pageHref(params: URLSearchParams, page: number): string {
  const next = new URLSearchParams(params);
  if (page <= 1) next.delete("page");
  else next.set("page", String(page));
  return next.size ? `/inventory?${next}` : "/inventory";
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await requireInventoryContext();
  const params = await searchParams;
  const q = stringParam(params, "q");
  const rawType = stringParam(params, "type");
  const type = rawType === "QUANTITY" || rawType === "UNIQUE" ? rawType : undefined;
  const rawStock = stringParam(params, "stock");
  const stock = rawStock === "yes" || rawStock === "no" ? rawStock : undefined;
  const locationId = stringParam(params, "location");
  const rawStatus = stringParam(params, "status");
  const status = rawStatus === "ACTIVE" || rawStatus === "INACTIVE" ? rawStatus : undefined;
  const requestedPage = Math.max(1, Number.parseInt(stringParam(params, "page") || "1", 10) || 1);

  const [locations, searchMatches, locationMatches] = await Promise.all([
    context.db.storageLocation.findMany({
      where: {
        workspaceId: context.workspaceId,
        OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
      },
      orderBy: { code: "asc" },
    }),
    q
      ? context.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT DISTINCT item.id
          FROM inventory_item AS item
          LEFT JOIN item_variant AS variant ON variant.inventory_item_id = item.id
          LEFT JOIN unique_stock_unit AS unit ON unit.item_variant_id = variant.id
          WHERE item.workspace_id = ${context.workspaceId}::uuid
            AND item.business_unit_id = ${context.businessUnitId}::uuid
            AND (
              item.name ILIKE ${`%${q}%`} OR item.item_code ILIKE ${`%${q}%`}
              OR variant.variant_code ILIKE ${`%${q}%`}
              OR variant.attributes_json::text ILIKE ${`%${q}%`}
              OR unit.individual_code ILIKE ${`%${q}%`}
            )
        `)
      : Promise.resolve([]),
    locationId
      ? context.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          WITH quantity_location_delta AS (
            SELECT movement.item_variant_id,
                   movement.storage_location_to_id AS location_id,
                   movement.quantity AS delta
            FROM stock_movement AS movement
            JOIN inventory_lot AS lot ON lot.id = movement.inventory_lot_id
            WHERE movement.business_unit_id = ${context.businessUnitId}::uuid
              AND lot.tracking_mode = 'quantity'
              AND movement.movement_type NOT IN ('return_defective','return_disposal')
              AND movement.storage_location_to_id IS NOT NULL
            UNION ALL
            SELECT movement.item_variant_id,
                   movement.storage_location_from_id AS location_id,
                   CASE WHEN movement.movement_type = 'location_transfer'
                        THEN -movement.quantity ELSE movement.quantity END AS delta
            FROM stock_movement AS movement
            JOIN inventory_lot AS lot ON lot.id = movement.inventory_lot_id
            WHERE movement.business_unit_id = ${context.businessUnitId}::uuid
              AND lot.tracking_mode = 'quantity'
              AND movement.storage_location_from_id IS NOT NULL
          ), quantity_items AS (
            SELECT variant.inventory_item_id
            FROM quantity_location_delta AS delta
            JOIN item_variant AS variant ON variant.id = delta.item_variant_id
            WHERE delta.location_id = ${locationId}::uuid
            GROUP BY variant.inventory_item_id
            HAVING SUM(delta.delta) > 0
          ), unique_items AS (
            SELECT DISTINCT variant.inventory_item_id
            FROM unique_stock_unit AS unit
            JOIN item_variant AS variant ON variant.id = unit.item_variant_id
            WHERE unit.workspace_id = ${context.workspaceId}::uuid
              AND unit.storage_location_id = ${locationId}::uuid
              AND unit.status = 'in_stock'
          )
          SELECT inventory_item_id AS id FROM quantity_items
          UNION
          SELECT inventory_item_id AS id FROM unique_items
        `)
      : Promise.resolve([]),
  ]);

  const idFilters: Prisma.InventoryItemWhereInput[] = [];
  if (q) idFilters.push({ id: { in: searchMatches.map((row) => row.id) } });
  if (locationId) idFilters.push({ id: { in: locationMatches.map((row) => row.id) } });
  const where: Prisma.InventoryItemWhereInput = {
    workspaceId: context.workspaceId,
    businessUnitId: context.businessUnitId,
    ...(status ? { status } : {}),
    ...(type
      ? {
          OR: [
            { managementType: type },
            { variants: { some: { costBalances: { some: { trackingMode: type } } } } },
          ],
        }
      : {}),
    ...(stock === "yes"
      ? { variants: { some: { costBalances: { some: { quantity: { gt: 0 } } } } } }
      : stock === "no"
        ? { variants: { none: { costBalances: { some: { quantity: { gt: 0 } } } } } }
        : {}),
    ...(idFilters.length ? { AND: idFilters } : {}),
  };

  const totalCount = await context.db.inventoryItem.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);
  const items = await context.db.inventoryItem.findMany({
    where,
    include: {
      variants: {
        include: {
          inventoryReservations: { where: { status: "RESERVED" }, select: { quantity: true } },
          costBalances: { where: { businessUnitId: context.businessUnitId } },
          inventoryLots: { where: { remainingQuantity: { gt: 0 } }, select: { costStatus: true } },
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip: (currentPage - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  const activeParams = new URLSearchParams();
  for (const key of ["q", "type", "stock", "location", "status"] as const) {
    const value = stringParam(params, key);
    if (value) activeParams.set(key, value);
  }

  return (
    <div className="page">
      <ListDisplayState
        context={`${context.workspaceId}:${context.operatorId}:${context.businessUnitId}:${context.fiscalYear.year}`}
      />
      <header className="page-header">
        <div>
          <p className="eyebrow">Phase 1 / Inventory</p>
          <h1>商品・在庫</h1>
          <p className="muted">現在庫は在庫移動履歴から追跡できます。</p>
        </div>
        <div className="status-actions">
          <Link className="button secondary" href="/purchases">
            仕入一覧
          </Link>
          <Link className="button" href="/inventory/new">
            商品登録
          </Link>
        </div>
      </header>
      <form className="card inventory-filter-bar">
        <label className="field inventory-filter-search">
          <span>検索</span>
          <input
            name="q"
            defaultValue={q}
            placeholder="商品名・商品コード・バリアント・属性・個体コード"
          />
        </label>
        <label className="field">
          <span>管理種別</span>
          <select name="type" defaultValue={type ?? ""}>
            <option value="">すべて</option>
            <option value="QUANTITY">数量</option>
            <option value="UNIQUE">個体</option>
          </select>
        </label>
        <label className="field">
          <span>在庫</span>
          <select name="stock" defaultValue={stock ?? ""}>
            <option value="">すべて</option>
            <option value="yes">在庫あり</option>
            <option value="no">在庫なし</option>
          </select>
        </label>
        <label className="field">
          <span>保管場所</span>
          <select name="location" defaultValue={locationId}>
            <option value="">すべて</option>
            {locations.map((location) => (
              <option value={location.id} key={location.id}>
                {location.code} {location.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>状態</span>
          <select name="status" defaultValue={status ?? ""}>
            <option value="">すべて</option>
            <option value="ACTIVE">有効</option>
            <option value="INACTIVE">無効</option>
          </select>
        </label>
        <button className="button">検索</button>
      </form>
      <div className="table-wrap card">
        <div className="list-summary">
          <span>{totalCount.toLocaleString("ja-JP")}件</span>
          <span>
            {currentPage} / {totalPages}ページ
          </span>
        </div>
        <div className="mobile-records">
          {items.map((item) => {
            const quantity = item.variants.reduce(
              (s, v) => s + v.costBalances.reduce((s, b) => s + b.quantity, 0),
              0,
            );
            const held = item.variants.reduce(
              (s, v) => s + v.inventoryReservations.reduce((s, r) => s + r.quantity, 0),
              0,
            );
            return (
              <Link key={item.id} className="card card-link" href={`/inventory/${item.id}`}>
                <h2>{item.name}</h2>
                <p>
                  出品に使える {Math.max(0, quantity - held)} ／ 確保 {held}
                </p>
                <p className="muted">
                  管理上の残数 {quantity}・{item.status === "ACTIVE" ? "有効" : "無効"}
                </p>
                <span>商品を確認して出品する →</span>
              </Link>
            );
          })}
        </div>
        <table className="desktop-records">
          <thead>
            <tr>
              <th>商品</th>
              <th>種別</th>
              <th>出品に使える / 確保 / 管理残数</th>
              <th>管理原価</th>
              <th>平均・個別単価</th>
              <th>原価状態</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const quantity = item.variants.reduce(
                (sum, variant) =>
                  sum +
                  variant.costBalances.reduce(
                    (subtotal, balance) => subtotal + balance.quantity,
                    0,
                  ),
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
              const average = quantity ? cost / BigInt(quantity) : 0n;
              const held = item.variants.reduce(
                (s, v) => s + v.inventoryReservations.reduce((s, r) => s + r.quantity, 0),
                0,
              );
              const provisional = item.variants.some((variant) =>
                variant.inventoryLots.some((lot) => lot.costStatus === "PROVISIONAL"),
              );
              const costStatus = quantity === 0 ? "対象なし" : provisional ? "未確定" : "確定";
              return (
                <tr key={item.id}>
                  <td>
                    <Link href={`/inventory/${item.id}`}>
                      <strong>{item.name}</strong>
                      <br />
                      <small>{item.itemCode}</small>
                    </Link>
                  </td>
                  <td>{item.managementType === "QUANTITY" ? "数量" : "個体"}</td>
                  <td>
                    {Math.max(0, quantity - held)} / {held} / {quantity.toLocaleString("ja-JP")}
                  </td>
                  <td>¥{formatYen(cost)}</td>
                  <td>¥{formatYen(average)}</td>
                  <td>
                    <span className={`status-chip ${provisional ? "warning" : ""}`}>
                      {costStatus}
                    </span>
                  </td>
                  <td>
                    <span className="status-chip">
                      {item.status === "ACTIVE" ? "有効" : "無効"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {items.length === 0 ? (
          <p className="empty-state">条件に一致する商品がありません。</p>
        ) : null}
        <nav className="pagination" aria-label="商品一覧のページ送り">
          {currentPage > 1 ? (
            <Link className="button secondary" href={pageHref(activeParams, currentPage - 1)}>
              前へ
            </Link>
          ) : (
            <span />
          )}
          {currentPage < totalPages ? (
            <Link className="button secondary" href={pageHref(activeParams, currentPage + 1)}>
              次へ
            </Link>
          ) : null}
        </nav>
      </div>
    </div>
  );
}
