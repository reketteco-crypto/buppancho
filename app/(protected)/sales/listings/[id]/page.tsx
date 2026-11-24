import Link from "next/link";
import { notFound } from "next/navigation";
import { commerceContext } from "@/lib/commerce/view";
export default async function PreviousListingPage({ params }: { params: Promise<{ id: string }> }) {
  const c = await commerceContext(),
    { id } = await params;
  const row = await c.db.listing.findFirst({
    where: { id, salesSku: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId } },
    include: {
      salesSku: true,
      salesChannel: true,
      completion: true,
      priceHistory: { orderBy: { effectiveAt: "desc" } },
      reservations: { where: { status: "RESERVED" } },
    },
  });
  if (!row) notFound();
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <div>
          <p className="commerce-overline">以前の出品記録・閲覧のみ</p>
          <h1>{row.displayName ?? row.salesSku.name}</h1>
        </div>
      </header>
      <div className="commerce-editor">
        <div className="commerce-summary-line">
          <span>販路</span>
          <span>{row.salesChannel.name}</span>
        </div>
        <div className="commerce-summary-line">
          <span>商品ID</span>
          <span>{row.externalListingId ?? "—"}</span>
        </div>
        <div className="commerce-summary-line">
          <span>出品時価格</span>
          <span>¥{row.currentPriceJpy.toLocaleString("ja-JP")}</span>
        </div>
        {row.reservations.length > 0 && (
          <p className="commerce-caption">この記録の確保在庫は保持されています。</p>
        )}
        {row.completion && (
          <Link className="button secondary" href={`/sales/orders/${row.completion.id}`}>
            販売実績を開く
          </Link>
        )}
        <details className="commerce-disclosure">
          <summary>価格の履歴</summary>
          {row.priceHistory.map((p) => (
            <div className="commerce-summary-line" key={p.id}>
              <span>{p.effectiveAt.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}</span>
              <span>¥{p.priceJpy.toLocaleString("ja-JP")}</span>
            </div>
          ))}
        </details>
        <div className="commerce-action-row">
          <Link className="commerce-text-button" href="/sales/history">
            以前の出品一覧へ
          </Link>
        </div>
      </div>
    </div>
  );
}
