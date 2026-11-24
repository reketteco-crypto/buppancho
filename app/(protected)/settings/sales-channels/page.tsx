import { InputReturnLink } from "@/components/input-return-link";
import { randomUUID } from "node:crypto";
import { ChannelEditor, DeliveryMethodEditor } from "@/components/commerce/settings-form";
import { commerceContext, commerceOptions, todayTokyo } from "@/lib/commerce/view";
export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const query = await searchParams;
  const c = await commerceContext(),
    options = await commerceOptions(c);
  const accounts = await c.db.moneyAccount.findMany({
    where: {
      workspaceId: c.workspaceId,
      businessUnitId: c.businessUnitId,
      reportingEntityId: c.reportingEntityId,
      accountKind: { not: "OWNER_CLEARING" },
      active: true,
    },
    select: { id: true, name: true },
  });
  const base = { context: c.context, date: todayTokyo() };
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>販路・配送方法</h1>
      </header>
      <InputReturnLink returnTo={query.returnTo} />
      <div className="commerce-editor">
        <section>
          <h2>販路</h2>
          {options.channels.map((ch) => (
            <details className="commerce-disclosure" key={`${ch.id}:${ch.revision}`}>
              <summary>
                {ch.name}
                <span>{ch.rate === "" ? "手数料未設定" : `${ch.rate}%`}</span>
              </summary>
              <ChannelEditor
                accounts={accounts}
                initial={{
                  ...base,
                  idempotencyKey: randomUUID(),
                  id: ch.id,
                  revision: ch.revision,
                  name: ch.name,
                  receivingAccountId: ch.receivingAccountId,
                  feeDeducted: ch.feeDeducted,
                  shippingDeducted: ch.shippingDeducted,
                  feeRate: ch.rate,
                  shipping: ch.shipping,
                  deliveryMethodId: ch.methodId,
                }}
                methods={options.methods}
              />
            </details>
          ))}
          <details className="commerce-disclosure">
            <summary>＋ 販路を追加</summary>
            <ChannelEditor
              accounts={accounts}
              initial={{
                ...base,
                idempotencyKey: randomUUID(),
                id: "",
                revision: 0,
                name: "",
                feeRate: "",
                shipping: "",
                deliveryMethodId: "",
              }}
              methods={options.methods}
            />
          </details>
        </section>
        <section className="commerce-section">
          <h2>配送方法</h2>
          {options.methods.map((m) => (
            <details className="commerce-disclosure" key={`${m.id}:${m.revision}`}>
              <summary>{m.name}</summary>
              <DeliveryMethodEditor
                initial={{
                  ...base,
                  idempotencyKey: randomUUID(),
                  id: m.id,
                  revision: m.revision,
                  name: m.name,
                  shipping: m.shipping,
                  allocationMethod: m.allocation as
                    | "VALUE"
                    | "QUANTITY"
                    | "WEIGHT"
                    | "VOLUME"
                    | "EQUAL"
                    | "MANUAL",
                }}
              />
            </details>
          ))}
          <details className="commerce-disclosure">
            <summary>＋ 配送方法を追加</summary>
            <DeliveryMethodEditor
              initial={{
                ...base,
                idempotencyKey: randomUUID(),
                id: "",
                revision: 0,
                name: "",
                shipping: "",
                allocationMethod: "VALUE",
              }}
            />
          </details>
        </section>
      </div>
    </div>
  );
}
