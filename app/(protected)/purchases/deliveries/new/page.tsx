import { randomUUID } from "node:crypto";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { DeliveryEditor } from "@/components/commerce/delivery-form";
import { purchaseLineBases } from "@/lib/commerce/purchase-history";

export default async function NewDelivery({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string; import?: string }>;
}) {
  const c = await commerceContext(),
    { purchase, import: importFile } = await searchParams;
  const [lines, methods] = await Promise.all([
    c.db.purchaseDocumentLine.findMany({
      where: {
        document: {
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          reportingEntityId: c.reportingEntityId,
          status: { not: "CANCELLED" },
        },
        ...(purchase ? { documentId: purchase } : {}),
      },
      include: {
        document: true,
        deliveries: true,
        receipts: { include: { receipt: true, deliveryLinks: true } },
      },
      orderBy: [{ document: { purchasedDate: "desc" } }, { position: "asc" }],
    }),
    c.db.deliveryMethod.findMany({
      where: { workspaceId: c.workspaceId, active: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const options = lines
    .map((l) => ({
      id: l.id,
      name: l.name,
      sourceName: l.sourceName,
      purchase: `${l.document.code} ${l.document.supplierName}`,
      reference: l.document.externalReference || "",
      remaining: l.quantity - l.deliveries.reduce((s, r) => s + r.quantity, 0),
      revision: l.document.revision,
      receipts: l.receipts
        .filter((r) => !r.deliveryLineId)
        .map((r) => ({
          id: r.id,
          quantity: r.quantity - r.deliveryLinks.reduce((s, l) => s + l.quantity, 0),
          date: r.receipt.receivedDate.toISOString().slice(0, 10),
        }))
        .filter((r) => r.quantity > 0),
    }))
    .filter((l) => l.remaining > 0);
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>配送を記録</h1>
      </header>
      <DeliveryEditor
        importOpen={importFile === "1"}
        initial={{
          context: c.context,
          idempotencyKey: randomUUID(),
          date: todayTokyo(),
          deliveryMethodId: "",
          counterpartyId: "",
          reference: "",
          memo: "",
          reason: "",
          lines: [],
          charges: [],
          bases: await purchaseLineBases(
            c.db,
            c,
            todayTokyo(),
            lines.filter((l) => options.some((o) => o.id === l.id)),
          ),
          receiptLinks: [],
        }}
        lines={options}
        methods={methods.map((m) => ({
          id: m.id,
          name: m.name,
          revision: m.revision,
          allocationMethod: m.defaultAllocationMethod,
        }))}
      />
    </div>
  );
}
