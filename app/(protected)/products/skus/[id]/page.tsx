import { InputReturnLink } from "@/components/input-return-link";
import { supplyPrices } from "@/lib/commerce/supplies";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { stockChoices } from "@/lib/commerce/stock-choices";
import { SkuEditor } from "@/components/commerce/sku-form";
export default async function EditSkuPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const query = await searchParams;
  const c = await commerceContext(),
    { id } = await params,
    options = await stockChoices(c);
  const sku = await c.db.salesSku.findFirst({
    where: { id, workspaceId: c.workspaceId, businessUnitId: c.businessUnitId },
    include: { components: true, channelSettings: true, supplySettings: true },
  });
  if (!sku) notFound();
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <div>
          <p className="commerce-overline">{sku.skuCode}</p>
          <h1>販売商品を編集</h1>
        </div>
      </header>
      <InputReturnLink returnTo={query.returnTo} />
      <SkuEditor
        supplies={await supplyPrices(c.db, c, todayTokyo())}
        initial={{
          context: c.context,
          idempotencyKey: randomUUID(),
          date: todayTokyo(),
          id: sku.id,
          revision: sku.revision,
          name: sku.name,
          price: sku.expectedPriceJpy?.toString() ?? "",
          components: sku.components.map((p) => ({
            itemVariantId: p.itemVariantId,
            uniqueStockUnitId: p.uniqueStockUnitId,
            requiredQuantity: p.requiredQuantity,
          })),
          supplies: sku.supplySettings.map((s) => ({
            supplyItemId: s.supplyItemId,
            purpose: s.purpose as "PACKING" | "COMPONENT",
            quantity: s.quantity.toString(),
            unitCost: s.unitCostJpy?.toString() ?? "",
          })),
          channels: sku.channelSettings.map((ch) => ({
            channelId: ch.salesChannelId,
            price: ch.priceJpy?.toString() ?? "",
            shipping: ch.shippingJpy?.toString() ?? "",
            deliveryMethodId: ch.deliveryMethodId ?? "",
          })),
        }}
        products={options.choices}
        channels={options.channels}
        methods={options.methods}
      />
    </div>
  );
}
