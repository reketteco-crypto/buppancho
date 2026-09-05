import Link from "next/link";
import { requireInventoryContext } from "@/lib/inventory/context";
import { formatYen } from "@/lib/inventory/money";

const status = {
  DRAFT: "下書き",
  FINALIZED: "確定",
  CANCELLED: "取消",
  ORDERED: "発注済み",
  PAID: "支払済み",
  PARTIALLY_RECEIVED: "一部入庫",
  RECEIVED: "入庫済み",
  COSTING: "原価計算中",
} as const;
export default async function PurchasesPage() {
  const context = await requireInventoryContext();
  const rows = await context.db.purchase.findMany({
    where: { workspaceId: context.workspaceId, businessUnitId: context.businessUnitId },
    include: {
      supplier: true,
      lines: {
        select: {
          trackingMode: true,
          orderedQuantity: true,
          sourceName: true,
          itemVariant: { select: { inventoryItem: { select: { name: true } } } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ purchasedDate: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Purchases</p>
          <h1>仕入一覧</h1>
          <p className="muted">下書き、確定、取消の履歴を確認できます。</p>
        </div>
        <div className="status-actions">
          <Link className="button" href="/purchases/new">
            仕入れ登録
          </Link>
        </div>
      </header>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>仕入番号</th>
              <th>仕入日</th>
              <th>内容</th>
              <th>仕入先</th>
              <th>内訳</th>
              <th>総額</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const names = [
                ...new Set(
                  row.lines.map((line) => line.itemVariant.inventoryItem.name || line.sourceName),
                ),
              ];
              const quantityCount = row.lines.reduce(
                (sum, line) => sum + (line.trackingMode === "QUANTITY" ? line.orderedQuantity : 0),
                0,
              );
              const uniqueCount = row.lines.filter((line) => line.trackingMode === "UNIQUE").length;
              const breakdown = [
                quantityCount ? `数量 ${quantityCount.toLocaleString("ja-JP")}個` : "",
                uniqueCount ? `個体 ${uniqueCount.toLocaleString("ja-JP")}点` : "",
              ]
                .filter(Boolean)
                .join(" / ");
              return (
                <tr key={row.id}>
                  <td>
                    <Link href={`/purchases/${row.id}`}>
                      <strong>{row.purchaseCode}</strong>
                    </Link>
                  </td>
                  <td>{row.purchasedDate.toISOString().slice(0, 10)}</td>
                  <td className="purchase-summary">
                    <strong>{names.slice(0, 2).join("、") || "商品名なし"}</strong>
                    {names.length > 2 ? <small>ほか{names.length - 2}商品</small> : null}
                    {row.orderNumber ? <small>注文番号: {row.orderNumber}</small> : null}
                  </td>
                  <td>{row.supplier.name}</td>
                  <td>
                    {breakdown || `${row.lines.length}明細`}
                    <small>{row.lines.length}明細</small>
                  </td>
                  <td>¥{formatYen(row.purchaseTotalJpy)}</td>
                  <td>
                    <span className="status-chip">{status[row.status]}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="empty-state">仕入れはまだありません。</p> : null}
      </div>
    </div>
  );
}
