import { randomUUID } from "node:crypto";
import { SaleEditor } from "@/components/commerce/sale-form";
import { commerceContext, commerceOptions, todayTokyo } from "@/lib/commerce/view";
import { Precise } from "@/lib/commerce/allocation";
import type { SaleInput } from "@/lib/commerce/input";

export default async function NewSalePage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; sku?: string; channel?: string }>;
}) {
  const c = await commerceContext(),
    query = await searchParams,
    options = await commerceOptions(c);
  const draft = query.draft
    ? await c.db.workflowDraft.findFirst({
        where: {
          id: query.draft,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          year: c.fiscalYear.year,
          kind: "COMMERCE_SALE",
          archivedAt: null,
          baseSnapshot: { path: ["reportingEntityId"], equals: c.reportingEntityId },
        },
      })
    : null;
  if (query.draft && !draft)
    return (
      <div className="commerce">
        <h1>途中保存を開けません</h1>
        <p>元の入力者・部門・申告主体・年度を確認してください。</p>
      </div>
    );
  const sku = options.skus.find((s) => s.id === query.sku),
    channel = options.channels.find((v) => v.id === query.channel) ?? options.channels[0],
    preference = sku?.channels.find((p) => p.channelId === channel?.id);
  const price = preference?.price || sku?.price || "",
    methodId = preference?.methodId || channel?.methodId || "";
  const fee =
    price !== "" && channel?.rate !== "" && channel?.rate !== undefined
      ? new Precise(price).mul(channel.rate).div(100).floor().toFixed(0)
      : "";
  const initial: SaleInput = {
    idempotencyKey: randomUUID(),
    context: c.context,
    valuationPosition: "LAST",
    draftId: draft?.id ?? randomUUID(),
    draftRevision: draft?.revision ?? 0,
    date: todayTokyo(),
    skuId: sku?.id ?? "",
    skuRevision: sku?.revision ?? 0,
    channelId: channel?.id ?? "",
    channelRevision: channel?.revision ?? 0,
    quantity: 1,
    price,
    fee,
    shipping:
      preference?.shipping ||
      options.methods.find((m) => m.id === methodId)?.shipping ||
      channel?.shipping ||
      "",
    deliveryMethodId: methodId,
    externalId: "",
    buyer: "",
    memo: "",
    ...(draft?.payload as Partial<SaleInput> | undefined),
  };
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>販売を記録</h1>
      </header>
      <SaleEditor
        initial={initial}
        draftId={draft?.id ?? initial.draftId}
        draftRevision={draft?.revision ?? 0}
        skus={options.skus}
        channels={options.channels}
        methods={options.methods}
      />
    </div>
  );
}
