import { InputReturnLink } from "@/components/input-return-link";
import { accountBalances } from "@/lib/commerce/money";
import { supplyPrices } from "@/lib/commerce/supplies";
import { randomUUID } from "node:crypto";
import { PurchaseEditor } from "@/components/commerce/purchase-form";
import { commerceContext, purchaseOptions, todayTokyo } from "@/lib/commerce/view";
import type { BuyInput } from "@/lib/commerce/input";

export default async function NewPurchasePage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; purpose?: string; repeat?: string; returnTo?: string }>;
}) {
  const c = await commerceContext(),
    query = await searchParams;
  const options = await purchaseOptions(c);
  const draft = query.draft
    ? await c.db.workflowDraft.findFirst({
        where: {
          id: query.draft,
          workspaceId: c.workspaceId,
          businessUnitId: c.businessUnitId,
          operatorId: c.operatorId,
          year: c.fiscalYear.year,
          kind: "COMMERCE_PURCHASE",
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
  const repeat =
    query.repeat && /^[0-9a-f-]{36}$/.test(query.repeat)
      ? await c.db.purchaseDocument.findFirst({
          where: {
            id: query.repeat,
            workspaceId: c.workspaceId,
            businessUnitId: c.businessUnitId,
            reportingEntityId: c.reportingEntityId,
          },
        })
      : null;
  const initial: BuyInput = {
    idempotencyKey: randomUUID(),
    context: c.context,
    valuationPosition: "LAST",
    date: todayTokyo(),
    draftId: draft?.id ?? randomUUID(),
    draftRevision: draft?.revision ?? 0,
    supplierId: options.suppliers.find((s) => s.id === repeat?.supplierId)?.id ?? "",
    supplierName: repeat?.supplierName ?? "",
    supplierRevision: options.suppliers.find((s) => s.id === repeat?.supplierId)?.revision,
    currency: repeat?.currency ?? "JPY",
    exchangeRate: repeat?.exchangeRate?.toString() ?? "",
    locationId: options.locations[0]?.id ?? "",
    received: true,
    taxMode: "INCLUDED",
    taxAmount: "",
    memo: "",
    lines: [
      {
        purpose:
          query.purpose === "MATERIAL"
            ? "MATERIAL"
            : query.purpose === "EQUIPMENT"
              ? "EQUIPMENT"
              : "STOCK",
        clientId: randomUUID(),
        variantId: "",
        name: "",
        trackingMode: "QUANTITY",
        quantity: 1,
        amount: "",
        priceBasis: "UNIT",
        weight: "",
        volume: "",
        condition: "",
      },
    ],
    charges: [],
    ...(draft?.payload as Partial<BuyInput> | undefined),
  };
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>購入を記録</h1>
      </header>
      <InputReturnLink returnTo={query.returnTo} />
      <PurchaseEditor
        accounts={(await accountBalances(c.db, c))
          .filter((a) => a.active)
          .map((a) => ({
            id: a.id,
            name: a.name,
            revision: a.revision,
            balance: a.balance.toString(),
            accountKind: a.accountKind,
          }))}
        initial={initial}
        draftId={draft?.id ?? initial.draftId}
        draftRevision={draft?.revision ?? 0}
        supplies={await supplyPrices(c.db, c, todayTokyo())}
        suppliers={options.suppliers}
        locations={options.locations}
      />
    </div>
  );
}
