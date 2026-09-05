import Link from "next/link";
import { redirect } from "next/navigation";
import { Boxes, PackagePlus, Search } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { formatYen } from "@/lib/inventory/money";

export default async function HomePage() {
  const session = await requireSession();
  if (!session.userAccount.workspace.setupCompletedAt) redirect("/setup");
  const db = getDb();
  const businessUnitId = session.activeBusinessUnitId;
  const workspaceId = session.userAccount.workspaceId;
  const [balances, uniqueCount, recentPurchases, recentMovements] = businessUnitId
    ? await Promise.all([
        db.inventoryCostBalance.findMany({
          where: { businessUnitId },
          include: { itemVariant: { include: { inventoryItem: true } } },
        }),
        db.uniqueStockUnit.count({
          where: {
            workspaceId,
            status: "IN_STOCK",
            itemVariant: { inventoryItem: { businessUnitId } },
          },
        }),
        db.purchase.findMany({
          where: { workspaceId, businessUnitId },
          include: { supplier: true },
          orderBy: { createdAt: "desc" },
          take: 5,
        }),
        db.stockMovement.findMany({
          where: { businessUnitId },
          include: { itemVariant: { include: { inventoryItem: true } } },
          orderBy: { movementAt: "desc" },
          take: 5,
        }),
      ])
    : ([[], 0, [], []] as const);
  const quantity = balances.reduce(
    (sum, row) => sum + (row.trackingMode === "QUANTITY" ? row.quantity : 0),
    0,
  );
  const value = balances.reduce((sum, row) => sum + row.carryingCostTotalJpy, 0n);
  const quick = [
    ["/purchases/new", "仕入れ登録", PackagePlus],
    ["/inventory", "商品検索", Search],
    ["/inventory/operations/new", "在庫移動", Boxes],
  ] as const;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Phase 1 / Inventory</p>
          <h1>在庫ダッシュボード</h1>
          <p className="muted">
            {session.activeBusinessUnit?.name ?? "販売部門未選択"}・
            {session.selectedYear ? `${session.selectedYear}年` : "年度未選択"}
          </p>
        </div>
        <span className="status-chip">フェーズ1</span>
      </header>
      <div className="metric-grid">
        <div className="card metric">
          <span>在庫数量</span>
          <strong>{quantity.toLocaleString("ja-JP")}</strong>
        </div>
        <div className="card metric">
          <span>個体在庫</span>
          <strong>{uniqueCount.toLocaleString("ja-JP")}点</strong>
        </div>
        <div className="card metric">
          <span>管理原価総額</span>
          <strong>¥{formatYen(value)}</strong>
        </div>
        <div className="card metric">
          <span>原価未確定</span>
          <strong>0件</strong>
        </div>
      </div>
      <section className="section-block">
        <div className="section-heading">
          <div>
            <h2>クイック操作</h2>
            <p className="muted">よく使う登録を開始します。</p>
          </div>
        </div>
        <div className="card-grid">
          {quick.map(([href, label, Icon]) => (
            <Link href={href} className="card quick-card" key={href}>
              <Icon size={22} />
              <strong>{label}</strong>
            </Link>
          ))}
        </div>
      </section>
      <div className="two-column">
        <section className="card">
          <h2>最近の仕入れ</h2>
          {recentPurchases.length ? (
            <ul className="activity-list">
              {recentPurchases.map((row) => (
                <li key={row.id}>
                  <Link href={`/purchases/${row.id}`}>
                    <strong>{row.purchaseCode}</strong>
                    <span>
                      {row.supplier.name}・¥{formatYen(row.purchaseTotalJpy)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">仕入れはまだありません。</p>
          )}
        </section>
        <section className="card">
          <h2>最近の在庫移動</h2>
          {recentMovements.length ? (
            <ul className="activity-list">
              {recentMovements.map((row) => (
                <li key={row.id}>
                  <Link href={`/inventory/${row.itemVariant.inventoryItem.id}`}>
                    <strong>{row.itemVariant.inventoryItem.name}</strong>
                    <span>
                      {row.movementType}・{row.quantity}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">在庫移動はまだありません。</p>
          )}
        </section>
      </div>
    </div>
  );
}
