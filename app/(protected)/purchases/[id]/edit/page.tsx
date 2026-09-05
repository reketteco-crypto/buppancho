import { notFound } from "next/navigation";
import { PurchaseForm } from "@/components/forms/purchase-form";
import { requireInventoryContext } from "@/lib/inventory/context";

export default async function EditPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await requireInventoryContext();
  const purchase = await context.db.purchase.findFirst({
    where: {
      id,
      workspaceId: context.workspaceId,
      businessUnitId: context.businessUnitId,
      status: "DRAFT",
      purchaseType: { in: ["DOMESTIC", "USED_BUNDLE"] },
    },
    include: { lines: true },
  });
  if (!purchase) notFound();
  const [suppliers, locations, variants] = await Promise.all([
    context.db.counterparty.findMany({
      where: { workspaceId: context.workspaceId, type: "SUPPLIER", active: true },
      orderBy: { name: "asc" },
    }),
    context.db.storageLocation.findMany({
      where: {
        workspaceId: context.workspaceId,
        active: true,
        OR: [{ businessUnitId: null }, { businessUnitId: context.businessUnitId }],
      },
      orderBy: { code: "asc" },
    }),
    context.db.itemVariant.findMany({
      where: {
        active: true,
        inventoryItem: {
          workspaceId: context.workspaceId,
          businessUnitId: context.businessUnitId,
          status: "ACTIVE",
        },
      },
      include: { inventoryItem: true },
      orderBy: { inventoryItem: { name: "asc" } },
    }),
  ]);
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">{purchase.purchaseCode}</p>
          <h1>仕入下書きを編集</h1>
          <p className="muted">保存すると既存の下書き明細を置き換えます。</p>
        </div>
      </header>
      <PurchaseForm
        suppliers={suppliers.map((row) => ({ id: row.id, label: row.name }))}
        locations={locations.map((row) => ({ id: row.id, label: `${row.code} ${row.name}` }))}
        variants={variants.map((row) => ({
          id: row.id,
          label: `${row.inventoryItem.itemCode} ${row.inventoryItem.name}`,
        }))}
        today={purchase.purchasedDate.toISOString().slice(0, 10)}
        initial={{
          purchaseId: purchase.id,
          requestKey: purchase.requestKey,
          purchasedDate: purchase.purchasedDate.toISOString().slice(0, 10),
          supplierId: purchase.supplierId,
          storageLocationId: purchase.storageLocationId,
          orderNumber: purchase.orderNumber ?? "",
          purchaseTotalJpy: purchase.purchaseTotalJpy.toString(),
          memo: purchase.memo ?? "",
          lines: purchase.lines.map((line) => {
            const measurements = (line.draftMeasurementsJson ?? {}) as Record<string, string>;
            return {
              clientRef: crypto.randomUUID(),
              variant: { source: "EXISTING" as const, variantId: line.itemVariantId },
              trackingMode: line.trackingMode,
              conditionCategory: line.conditionCategory,
              conditionDescription: line.draftCondition ?? "",
              sourceName: line.sourceName,
              sourceUrl: line.sourceUrl ?? "",
              quantity: line.orderedQuantity,
              amountJpy: line.finalLandedCostJpy.toString(),
              individualCode: line.draftIndividualCode ?? "",
              measurements,
              measurementsText: Object.entries(measurements)
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n"),
              memo: line.draftMemo ?? "",
              commonMeasurements: {},
              commonMeasurementsText: "",
            };
          }),
        }}
      />
    </div>
  );
}
