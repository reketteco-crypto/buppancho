import Link from "next/link";
import { commerceContext } from "@/lib/commerce/view";
export default async function ListingHistory() {
  const c = await commerceContext();
  const rows = await c.db.listing.findMany({
    where: { salesSku: { workspaceId: c.workspaceId, businessUnitId: c.businessUnitId } },
    include: { salesSku: true, salesChannel: true },
    orderBy: { listedAt: "desc" },
    take: 100,
  });
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>以前の出品記録</h1>
      </header>
      <div className="commerce-list">
        {rows.map((r) => (
          <Link className="commerce-row" href={`/sales/listings/${r.id}`} key={r.id}>
            <div>
              <strong>{r.displayName ?? r.salesSku.name}</strong>
              <span className="commerce-secondary">
                {r.salesChannel.name} · {r.externalListingId}
              </span>
            </div>
            <span>¥{r.currentPriceJpy.toLocaleString("ja-JP")}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
