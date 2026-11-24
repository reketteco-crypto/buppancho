import { InputReturnLink } from "@/components/input-return-link";
import { supplyPrices } from "@/lib/commerce/supplies";
import { randomUUID } from "node:crypto";
import { commerceContext, todayTokyo } from "@/lib/commerce/view";
import { stockChoices } from "@/lib/commerce/stock-choices";
import { SkuEditor } from "@/components/commerce/sku-form";
export default async function NewSkuPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const query = await searchParams;
  const c = await commerceContext(),
    options = await stockChoices(c);
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>セット・販売商品を作成</h1>
      </header>
      <InputReturnLink returnTo={query.returnTo} />
      <SkuEditor
        supplies={await supplyPrices(c.db, c, todayTokyo())}
        initial={{
          context: c.context,
          idempotencyKey: randomUUID(),
          date: todayTokyo(),
          id: "",
          revision: 0,
          name: "",
          price: "",
          components: [{ itemVariantId: null, uniqueStockUnitId: null, requiredQuantity: 1 }],
          channels: [],
        }}
        products={options.choices}
        channels={options.channels}
        methods={options.methods}
      />
    </div>
  );
}
