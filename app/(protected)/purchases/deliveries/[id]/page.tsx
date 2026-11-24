import Link from "next/link";
import { commerceContext } from "@/lib/commerce/view";
import { SettlementSection } from "@/components/commerce/settlement-section";
import { PurchaseCosts } from "@/components/commerce/cost-section";

export default async function DeliveryDetail({ params }: { params: Promise<{ id: string }> }) {
  const c = await commerceContext(),
    { id } = await params;
  const d = await c.db.inboundDelivery.findFirstOrThrow({
    where: {
      id,
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      reportingEntityId: c.reportingEntityId,
    },
    include: {
      lines: {
        orderBy: { position: "asc" },
        include: {
          purchaseLine: { include: { document: true } },
          receipts: true,
          receiptLinks: true,
        },
      },
      charges: {
        orderBy: { createdAt: "asc" },
        include: { allocations: true, supersededBy: true },
      },
    },
  });
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <div>
          <p className="commerce-overline">{d.code}</p>
          <h1>{d.methodName || "配送"}</h1>
        </div>
        <span className="commerce-secondary">{d.shippedDate.toISOString().slice(0, 10)}</span>
      </header>
      <div className="commerce-editor">
        <div className="commerce-list">
          {d.lines.map((l) => (
            <div className="commerce-row" key={l.id}>
              <div>
                <strong>{l.purchaseLine.name}</strong>
                <Link
                  className="commerce-secondary"
                  href={`/purchases/${l.purchaseLine.documentId}`}
                >
                  {l.purchaseLine.document.code} · {l.purchaseLine.document.supplierName}
                </Link>
              </div>
              <span>
                {l.quantity}点
                <small className="commerce-secondary">
                  受取{" "}
                  {l.receipts.reduce((s, r) => s + r.quantity, 0) +
                    l.receiptLinks.reduce((s, r) => s + r.quantity, 0)}
                  点
                </small>
              </span>
            </div>
          ))}
        </div>
        <SettlementSection c={c} kind="DELIVERY_PAYMENT" id={d.id} />
        <SettlementSection
          c={c}
          kind="DELIVERY_CREDIT_REFUND"
          id={d.id}
          label="金額訂正後の過払い返金"
          hideEmpty
        />
        <PurchaseCosts
          c={c}
          source={{ deliveryId: d.id, revision: d.revision }}
          lines={d.lines.map((l) => ({
            id: l.purchaseLineId,
            name: l.purchaseLine.name,
            itemVariantId: l.purchaseLine.itemVariantId,
            weight: l.purchaseLine.weightG?.toString() ?? "",
            volume: l.purchaseLine.volumeCm3?.toString() ?? "",
          }))}
          charges={d.charges}
        />
        {d.reference && <p className="commerce-secondary">伝票 {d.reference}</p>}
        {d.memo && <p>{d.memo}</p>}
        <Link className="commerce-text-button" href="/purchases">
          購入一覧へ
        </Link>
      </div>
    </div>
  );
}
